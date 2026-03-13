/**
 * Read-only data access layer for the local Signal Desktop database.
 *
 * This module owns:
 * - OS-specific path resolution for Signal's encrypted SQLite file
 * - opening SQLCipher (@signalapp/sqlcipher) in read-only mode
 * - query helpers used by the CLI commands
 * - small formatting helpers shared by interactive and non-interactive output
 */

import os from 'os';
import path from 'path';
import Database from '@signalapp/sqlcipher';

/** Resolve the default Signal application directory for the current OS. */
function getFolderPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Signal');
  }
  if (platform === 'linux') {
    return path.join(os.homedir(), '.config', 'Signal');
  }
  return path.join(os.homedir(), 'Library/Application Support/Signal');
}

/** Resolve the default encrypted SQLite path used by Signal Desktop. */
function getDBPath() {
  return path.join(getFolderPath(), 'sql/db.sqlite');
}

/** Read the SQLCipher key exactly as provided by env configuration. */
function getKey() {
  return process.env.SIGNAL_DECRYPTION_KEY;
}

/** Open the Signal database in read-only mode and apply the SQLCipher key. */
function openDB() {
  const key = getKey();
  if (!key || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('Invalid SIGNAL_DECRYPTION_KEY: must be a non-empty hex string');
  }
  const db = new Database(getDBPath());
  db.pragma(`key = "x'${key}'"`)
  db.initTokenizer();
  db.pragma('query_only = ON');
  return db;
}

/** Format timestamps for the CLI output. */
function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('en-US');
}

/**
 * Normalize message rows for compact CLI rendering.
 *
 * The formatter intentionally hides schema details and returns only the pieces
 * that the CLI needs to build timeline lines.
 */
function formatMessage(msg, options = {}) {
  const maxLen = options.bodyMaxLen ?? 80;
  const body = (msg.body || '(no text)').replace(/\n/g, ' ').slice(0, maxLen);
  const suffix = (msg.body || '').length > maxLen ? '...' : '';
  const conv = msg.conversationName || msg.conversationPhone || msg.conversationId || '?';
  const dir = msg.type === 'incoming' ? '▶' : '◀';
  return { body: `${body}${suffix}`, conv, dir };
}

/** Format a call history record for display. */
function formatCall(msg) {
  const dir = (msg.callDirection || '').toLowerCase() === 'incoming' ? '📞↓' : '📞↑';
  const status = msg.callStatus || '?';
  const mode = msg.callMode || msg.callType || '';
  const parts = [dir, status];
  if (mode && mode !== 'Group') parts.push(mode);
  return parts.join(' ');
}

/**
 * Unified message query with composable filters.
 *
 * options:
 * - conv:        conversation name or ID
 * - unread:      only unread incoming messages
 * - unanswered:  incoming without outgoing reply (implies incoming)
 * - olderThan:   hours threshold for unanswered (default 24)
 * - search:      FTS5 full-text search query
 * - from / to:   date range (ISO string or timestamp)
 * - incoming:    only incoming
 * - outgoing:    only outgoing
 * - limit:       max results (default 20)
 *
 * Returns { messages, total, conversationName? }
 */
function getMessages(db, options = {}) {
  const {
    conv, unread, unanswered, olderThan = 24,
    search, from, to,
    incoming, outgoing,
    limit = 20,
  } = options;

  // Validate conflicting direction options
  if (incoming && outgoing) {
    throw new Error('Cannot combine --incoming and --outgoing');
  }
  if (unread && outgoing) {
    throw new Error('Cannot combine --unread and --outgoing (unread messages are always incoming)');
  }

  // Resolve conversation filter
  // Supports: UUID (direct ID), "=exact name" (exact match), or fuzzy LIKE search.
  // Fuzzy search with multiple matches queries across all matching conversations.
  let conversationIds = null;
  let conversationName = null;
  if (conv) {
    if (/^[0-9a-f]+(-[0-9a-f]+){3,}$/i.test(conv)) {
      conversationIds = [conv];
    } else if (conv.startsWith('=')) {
      const exact = conv.slice(1);
      const convs = findConversations(db, exact, { exact: true });
      if (convs.length === 0) {
        throw new Error(`Conversation not found: "${exact}"`);
      }
      conversationIds = [convs[0].id];
      conversationName = convs[0].name || convs[0].e164;
    } else {
      const convs = findConversations(db, conv);
      if (convs.length === 0) {
        throw new Error(`Conversation not found: "${conv}"`);
      }
      conversationIds = convs.map((c) => c.id);
      conversationName = convs.length === 1
        ? (convs[0].name || convs[0].e164)
        : `${conv} (${convs.length} conversations)`;
    }
  }

  // Build SELECT columns
  const selectCols = [
    'm.id', 'm.body', 'm.sent_at', 'm.type', 'm.conversationId',
    'COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName', 'c.e164 AS conversationPhone',
  ];

  // Include call-history fields when viewing a single specific conversation
  const includeCallHistory = conversationIds && conversationIds.length === 1;
  if (includeCallHistory) {
    selectCols.push('m.callId');
    selectCols.push('ch.direction AS callDirection', 'ch.status AS callStatus', 'ch.mode AS callMode', 'ch.type AS callType');
  }

  // has_call_after subselect for unread mode
  if (unread) {
    selectCols.push(`(SELECT 1 FROM messages m2
      WHERE m2.conversationId = m.conversationId
        AND m2.type = 'call-history'
        AND m2.sent_at > m.sent_at
      LIMIT 1) AS has_call_after`);
  }

  // Build FROM / JOIN
  let fromClause = 'FROM messages m\n    LEFT JOIN conversations c ON m.conversationId = c.id';
  if (includeCallHistory) {
    fromClause += '\n    LEFT JOIN callsHistory ch ON m.callId = ch.callId';
  }

  // Unanswered: JOIN on precomputed last outgoing per conversation (avoids correlated NOT EXISTS)
  if (unanswered) {
    fromClause += `\n    LEFT JOIN (
      SELECT conversationId, MAX(sent_at) AS last_out
      FROM messages WHERE type = 'outgoing'
      GROUP BY conversationId
    ) lo ON lo.conversationId = m.conversationId`;
  }

  // FTS join
  const ftsQuery = search ? toFTS5Query(search) : null;
  if (ftsQuery) {
    fromClause = `FROM messages_fts fts\n    JOIN messages m ON m.rowid = fts.rowid\n    LEFT JOIN conversations c ON m.conversationId = c.id`;
    if (includeCallHistory) {
      fromClause += '\n    LEFT JOIN callsHistory ch ON m.callId = ch.callId';
    }
  }

  // Build WHERE conditions
  const conditions = [];
  const params = [];

  if (ftsQuery) {
    conditions.push('messages_fts MATCH ?');
    params.push(ftsQuery);
  }

  if (includeCallHistory) {
    conditions.push("(m.type = 'call-history' OR (m.body IS NOT NULL AND m.body != ''))");
  } else {
    conditions.push("m.body IS NOT NULL AND m.body != ''");
  }

  // Type filters
  if (includeCallHistory) {
    if (incoming) {
      conditions.push("(m.type = 'incoming' OR m.type = 'call-history')");
    } else if (outgoing) {
      conditions.push("(m.type = 'outgoing' OR m.type = 'call-history')");
    } else {
      conditions.push("(m.type IN ('incoming', 'outgoing') OR m.type = 'call-history')");
    }
  } else if (unread || incoming) {
    conditions.push("m.type = 'incoming'");
  } else if (outgoing) {
    conditions.push("m.type = 'outgoing'");
  } else if (!unanswered) {
    conditions.push("m.type IN ('incoming', 'outgoing')");
  }

  if (unread) {
    conditions.push('m.readStatus = 1');
  }

  if (unanswered) {
    const cutoff = Date.now() - olderThan * 60 * 60 * 1000;
    conditions.push("m.type = 'incoming'");
    conditions.push('m.sent_at < ?');
    params.push(cutoff);
    // No outgoing reply after this message (using precomputed last outgoing)
    conditions.push('(lo.last_out IS NULL OR lo.last_out < m.sent_at)');
  }

  if (conversationIds) {
    if (conversationIds.length === 1) {
      conditions.push('m.conversationId = ?');
      params.push(conversationIds[0]);
    } else {
      conditions.push(`m.conversationId IN (${conversationIds.map(() => '?').join(', ')})`);
      params.push(...conversationIds);
    }
  }

  const fromTs = parseDateToTs(from);
  const toTs = parseDateToTs(to, true);
  if (fromTs != null) {
    conditions.push('m.sent_at >= ?');
    params.push(fromTs);
  }
  if (toTs != null) {
    conditions.push('m.sent_at <= ?');
    params.push(toTs);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join('\n      AND ') : '';

  // Unanswered mode: deduplicate per conversation (latest message + count)
  if (unanswered) {
    const innerSql = `SELECT ${selectCols.join(', ')},
      ROW_NUMBER() OVER (PARTITION BY m.conversationId ORDER BY m.sent_at DESC) AS rn,
      COUNT(*) OVER (PARTITION BY m.conversationId) AS rottingCount
    ${fromClause}\n    ${whereClause}`;
    const countSql = `SELECT COUNT(DISTINCT m.conversationId) as total ${fromClause}\n    ${whereClause}`;
    const { total } = db.prepare(countSql).get(params);
    const dataSql = `SELECT * FROM (${innerSql}) WHERE rn = 1 ORDER BY sent_at DESC LIMIT ?`;
    const messages = db.prepare(dataSql).all([...params, limit]);
    return { messages, total, conversationName };
  }

  // Count query
  const countSql = `SELECT COUNT(*) as total ${fromClause}\n    ${whereClause}`;
  const { total } = db.prepare(countSql).get(params);

  // Data query
  const dataSql = `SELECT ${selectCols.join(', ')}\n    ${fromClause}\n    ${whereClause}\n    ORDER BY m.sent_at DESC\n    LIMIT ?`;
  const messages = db.prepare(dataSql).all([...params, limit]);

  return { messages, total, conversationName };
}

/**
 * Find conversations matching a query (name or ID).
 */
function findConversations(db, query, options = {}) {
  const { type = null, limit = 20, exact = false } = options;
  let sql;
  let params;
  if (exact) {
    sql = `
    SELECT id, COALESCE(name, profileFullName, profileName) AS name, e164, type
    FROM conversations
    WHERE (name = ? OR profileFullName = ? OR profileName = ? OR e164 = ?)
  `;
    params = [query, query, query, query];
  } else {
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const q = `%${escaped}%`;
    sql = `
    SELECT id, COALESCE(name, profileFullName, profileName) AS name, e164, type
    FROM conversations
    WHERE (name LIKE ? ESCAPE '\\' OR profileFullName LIKE ? ESCAPE '\\' OR profileName LIKE ? ESCAPE '\\' OR id = ? OR e164 LIKE ? ESCAPE '\\')
  `;
    params = [q, q, q, query, q];
  }
  if (type === 'private' || type === 'group') {
    sql += ` AND type = ?`;
    params.push(type);
  }
  sql += ` ORDER BY active_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(params);
}

/**
 * Get a message by ID.
 * Primarily used after interactive selection from FTS search results.
 */
function getMessageById(db, id) {
  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName, c.e164 AS conversationPhone
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE m.id = ?
  `);
  return stm.get([id]);
}

/**
 * Convert user query to FTS5 syntax:
 * - space = OR (hello deadline → hello OR deadline)
 * - comma = AND (hello, deadline → hello AND deadline)
 * - each term gets a * suffix for prefix matching (hel → hel* matches hello, helpful...)
 *
 * This lets the CLI offer simple syntax without requiring raw FTS5 queries.
 */
function toFTS5Query(userQuery) {
  const q = (userQuery || '').trim();
  if (!q) return '';
  const andParts = q.split(',').map((p) => p.trim()).filter(Boolean);
  const ftsParts = andParts.map((part) => {
    const orTerms = part.split(/\s+/).filter(Boolean).map((t) => t + '*');
    if (orTerms.length === 0) return '';
    if (orTerms.length === 1) return orTerms[0];
    return '(' + orTerms.join(' OR ') + ')';
  });
  return ftsParts.filter(Boolean).join(' AND ');
}

/**
 * Parse a date string to a timestamp (ms).
 * `str` can be an ISO date (2025-01-15) or a number.
 * `endOfDay=true` shifts to end of day for inclusive `--to` filter.
 */
function parseDateToTs(str, endOfDay = false) {
  if (str == null || str === '') return null;
  if (typeof str === 'number') return str;

  // Relative offset: 10m, 5h, 8d
  const offsetMatch = String(str).match(/^(\d+)([mhd])$/);
  if (offsetMatch) {
    const val = parseInt(offsetMatch[1], 10);
    const unit = offsetMatch[2];
    const multipliers = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    return Date.now() - val * multipliers[unit];
  }

  // ISO date string
  const d = new Date(str);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date format: "${str}" (allowed: ISO date, relative offset like 10m/5h/8d)`);
  }
  if (endOfDay) {
    d.setHours(23, 59, 59, 999);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

/**
 * List conversations with activity.
 * Used for both text output and interactive mode menus.
 */
function getConversations(db, options = {}) {
  const { type = null, limit = 50 } = options;
  let sql = `
    SELECT id, COALESCE(name, profileFullName, profileName) AS name, e164, type, active_at
    FROM conversations
    WHERE active_at IS NOT NULL
  `;
  const params = [];
  if (type === 'private' || type === 'group') {
    sql += ` AND type = ?`;
    params.push(type);
  }
  sql += ` ORDER BY active_at DESC LIMIT ?`;
  params.push(limit);
  const stm = db.prepare(sql);
  return stm.all(params);
}

/**
 * Last N calls across conversations.
 * Joins via `messages.callId` to add conversation names to callsHistory records.
 */
function getCalls(db, limit = 20) {
  const stm = db.prepare(`
    SELECT ch.callId, ch.direction, ch.status, ch.mode, ch.type AS callType,
           ch.timestamp, COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName, c.e164 AS conversationPhone
    FROM callsHistory ch
    LEFT JOIN messages m ON m.callId = ch.callId
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE ch.timestamp IS NOT NULL
    GROUP BY ch.callId
    ORDER BY ch.timestamp DESC
    LIMIT ?
  `);
  return stm.all([limit]);
}

export {
  getFolderPath,
  getDBPath,
  openDB,
  formatDate,
  formatMessage,
  formatCall,
  getMessages,
  findConversations,
  getMessageById,
  toFTS5Query,
  parseDateToTs,
  getConversations,
  getCalls,
};
