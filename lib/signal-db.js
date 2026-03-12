/**
 * Read-only data access layer for the local Signal Desktop database.
 *
 * This module owns:
 * - OS-specific path resolution for Signal's encrypted SQLite file
 * - opening SQLCipher/better-sqlite3 in read-only mode
 * - query helpers used by the CLI commands
 * - small formatting helpers shared by interactive and non-interactive output
 */

import os from 'os';
import path from 'path';
import SQL from '@signalapp/better-sqlite3';

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
  const db = SQL(getDBPath(), { readonly: true });
  db.pragma(`key = "x'${getKey()}'"`);
  return db;
}

/** Format timestamps for the CLI's Czech locale output. */
function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('cs-CZ');
}

/**
 * Normalize message rows for compact CLI rendering.
 *
 * The formatter intentionally hides schema details and returns only the pieces
 * that the CLI needs to build timeline lines.
 */
function formatMessage(msg, options = {}) {
  const maxLen = options.bodyMaxLen ?? 80;
  const body = (msg.body || '(bez textu)').replace(/\n/g, ' ').slice(0, maxLen);
  const suffix = (msg.body || '').length > maxLen ? '...' : '';
  const conv = msg.conversationName || msg.conversationPhone || msg.conversationId || '?';
  const dir = msg.type === 'incoming' ? '▶' : '◀';
  return { body: `${body}${suffix}`, conv, dir };
}

/** Formátování záznamu hovoru pro výpis */
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

  // Resolve conversation filter
  let conversationId = null;
  let conversationName = null;
  if (conv) {
    if (conv.length >= 36 && conv.includes('-')) {
      conversationId = conv;
    } else {
      const convs = findConversations(db, conv);
      if (convs.length === 0) {
        return { error: `Konverzace nenalezena: "${conv}"`, messages: [], total: 0 };
      }
      if (convs.length > 1) {
        return { error: `Více konverzací odpovídá "${conv}":\n  ${convs.map(c => `${c.name || c.e164 || c.id}`).join('\n  ')}`, messages: [], total: 0 };
      }
      conversationId = convs[0].id;
      conversationName = convs[0].name || convs[0].e164;
    }
  }

  // Build SELECT columns
  const selectCols = [
    'm.id', 'm.body', 'm.sent_at', 'm.type', 'm.conversationId',
    'COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName', 'c.e164 AS conversationPhone',
  ];

  // Include call-history fields when viewing a specific conversation
  const includeCallHistory = !!conversationId;
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

  conditions.push("m.body IS NOT NULL AND m.body != ''");

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
    conditions.push('(m.readStatus = 0 OR m.readStatus IS NULL)');
  }

  if (unanswered) {
    const cutoff = Date.now() - olderThan * 60 * 60 * 1000;
    conditions.push("m.type = 'incoming'");
    conditions.push('(m.readStatus = 0 OR m.readStatus IS NULL)');
    conditions.push('m.sent_at < ?');
    params.push(cutoff);
    // No outgoing reply after this message (using precomputed last outgoing)
    conditions.push('(lo.last_out IS NULL OR lo.last_out < m.sent_at)');
  }

  if (conversationId) {
    conditions.push('m.conversationId = ?');
    params.push(conversationId);
  }

  let fromTs, toTs;
  try {
    fromTs = parseDateToTs(from);
    toTs = parseDateToTs(to, true);
  } catch (e) {
    return { error: e.message, messages: [], total: 0 };
  }
  if (fromTs != null) {
    conditions.push('m.sent_at >= ?');
    params.push(fromTs);
  }
  if (toTs != null) {
    conditions.push('m.sent_at <= ?');
    params.push(toTs);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join('\n      AND ') : '';

  try {
    // Unanswered mode: deduplicate per conversation (latest message + count)
    if (unanswered) {
      const innerSql = `SELECT ${selectCols.join(', ')},
        ROW_NUMBER() OVER (PARTITION BY m.conversationId ORDER BY m.sent_at DESC) AS rn,
        COUNT(*) OVER (PARTITION BY m.conversationId) AS rottingCount
      ${fromClause}\n    ${whereClause}`;
      const countSql = `SELECT COUNT(DISTINCT m.conversationId) as total ${fromClause}\n    ${whereClause}`;
      const { total } = db.prepare(countSql).get(...params);
      const dataSql = `SELECT * FROM (${innerSql}) WHERE rn = 1 ORDER BY sent_at DESC LIMIT ?`;
      const messages = db.prepare(dataSql).all(...params, limit);
      return { messages, total, conversationName };
    }

    // Count query
    const countSql = `SELECT COUNT(*) as total ${fromClause}\n    ${whereClause}`;
    const { total } = db.prepare(countSql).get(...params);

    // Data query
    const dataSql = `SELECT ${selectCols.join(', ')}\n    ${fromClause}\n    ${whereClause}\n    ORDER BY m.sent_at DESC\n    LIMIT ?`;
    const messages = db.prepare(dataSql).all(...params, limit);

    return { messages, total, conversationName };
  } catch {
    return { messages: [], total: 0, conversationName };
  }
}

/**
 * Najde konverzace odpovídající dotazu (název nebo ID)
 */
function findConversations(db, query) {
  const q = `%${query}%`;
  const stm = db.prepare(`
    SELECT id, COALESCE(name, profileFullName, profileName) AS name, e164, type
    FROM conversations
    WHERE name LIKE ? OR profileFullName LIKE ? OR profileName LIKE ? OR id = ? OR e164 LIKE ?
    ORDER BY active_at DESC
    LIMIT 20
  `);
  return stm.all(q, q, q, query, q);
}

/**
 * Získat zprávu podle ID.
 * Používá se hlavně po interaktivním výběru výsledku z FTS hledání.
 */
function getMessageById(db, id) {
  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName, c.e164 AS conversationPhone
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE m.id = ?
  `);
  return stm.get(id);
}

/**
 * Převod uživatelského dotazu na FTS5 syntax:
 * - mezera = OR (ahoj deadline → ahoj OR deadline)
 * - čárka = AND (ahoj, deadline → ahoj AND deadline)
 * - každý term má prefix * pro částečnou shodu (aho → aho* najde ahoj, ahojky...)
 *
 * CLI tak může nabízet jednoduchou syntax bez nutnosti psát přímo FTS5 dotazy.
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
 * Parsuje datum na timestamp (ms).
 * `str` může být ISO datum (2025-01-15) nebo číslo.
 * `endOfDay=true` posouvá horní hranici na konec dne pro inclusive filtr `--to`.
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
    throw new Error(`Neplatný formát data: "${str}" (povoleno: ISO datum, relativní offset jako 10m/5h/8d)`);
  }
  if (endOfDay) {
    d.setHours(23, 59, 59, 999);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

/**
 * Seznam konverzací s aktivitou.
 * Používá se jak pro textový list, tak pro nabídky v interaktivním režimu.
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
  return stm.all(...params);
}

/**
 * Posledních N hovorů napříč konverzacemi.
 * Vazba přes `messages.callId` doplňuje jméno konverzace k záznamům z callsHistory.
 */
function getCalls(db, limit = 20) {
  const stm = db.prepare(`
    SELECT ch.callId, ch.direction, ch.status, ch.mode, ch.type AS callType,
           ch.timestamp, COALESCE(c.name, c.profileFullName, c.profileName) AS conversationName, c.e164 AS conversationPhone
    FROM callsHistory ch
    LEFT JOIN messages m ON m.callId = ch.callId
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE ch.timestamp IS NOT NULL
    ORDER BY ch.timestamp DESC
    LIMIT ?
  `);
  return stm.all(limit);
}

export {
  getFolderPath,
  getDBPath,
  getKey,
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
