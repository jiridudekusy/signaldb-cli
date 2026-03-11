'use strict';

/**
 * Read-only data access layer for the local Signal Desktop database.
 *
 * This module owns:
 * - OS-specific path resolution for Signal's encrypted SQLite file
 * - opening SQLCipher/better-sqlite3 in read-only mode
 * - query helpers used by the CLI commands
 * - small formatting helpers shared by interactive and non-interactive output
 */

const os = require('os');
const path = require('path');
const SQL = require('@signalapp/better-sqlite3');

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
 * Posledních N nepřečtených příchozích zpráv.
 * has_call_after = 1 pokud v konverzaci proběhl call po této zprávě (reakce možná není potřeba).
 */
function getUnread(db, limit = 50) {
  const countStm = db.prepare(`
    SELECT COUNT(*) as total FROM messages m
    WHERE (m.readStatus = 0 OR m.readStatus IS NULL)
      AND m.type = 'incoming'
      AND (m.body IS NOT NULL AND m.body != '')
  `);
  const total = countStm.get().total;

  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           c.name AS conversationName, c.e164 AS conversationPhone,
           (SELECT 1 FROM messages m2
            WHERE m2.conversationId = m.conversationId
              AND m2.type = 'call-history'
              AND m2.sent_at > m.sent_at
            LIMIT 1) AS has_call_after
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE (m.readStatus = 0 OR m.readStatus IS NULL)
      AND m.type = 'incoming'
      AND m.body IS NOT NULL AND m.body != ''
    ORDER BY m.sent_at DESC
    LIMIT ?
  `);
  const messages = stm.all(limit);
  return { total, messages };
}

/**
 * Posledních N zpráv ze všech konverzací (smíchané podle času)
 */
function getLastMessages(db, limit = 20) {
  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           c.name AS conversationName, c.e164 AS conversationPhone
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE m.body IS NOT NULL AND m.body != ''
      AND m.type IN ('incoming', 'outgoing')
    ORDER BY m.sent_at DESC
    LIMIT ?
  `);
  return stm.all(limit);
}

/**
 * Najde konverzace odpovídající dotazu (název nebo ID)
 */
function findConversations(db, query) {
  const q = `%${query}%`;
  const stm = db.prepare(`
    SELECT id, name, e164, type
    FROM conversations
    WHERE name LIKE ? OR id = ? OR e164 LIKE ?
    ORDER BY active_at DESC
    LIMIT 20
  `);
  return stm.all(q, query, q);
}

/**
 * Posledních N zpráv z konverzace (podle ID nebo názvu).
 * Zahrnuje i call-history – hovory v timeline.
 */
function getConversationMessages(db, conversationIdOrName, limit = 10) {
  // Nejprve zjistit conversationId
  let conversationId = conversationIdOrName;
  let convName = null;

  if (conversationIdOrName.length < 36 || !conversationIdOrName.includes('-')) {
    const convs = findConversations(db, conversationIdOrName);
    if (convs.length === 0) {
      return { error: `Konverzace nenalezena: "${conversationIdOrName}"`, messages: [] };
    }
    if (convs.length > 1) {
      return { error: `Více konverzací odpovídá "${conversationIdOrName}":\n  ${convs.map(c => `${c.name || c.e164 || c.id}`).join('\n  ')}`, messages: [] };
    }
    conversationId = convs[0].id;
    convName = convs[0].name || convs[0].e164;
  }

  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId, m.callId,
           c.name AS conversationName, c.e164 AS conversationPhone,
           ch.direction AS callDirection, ch.status AS callStatus, ch.mode AS callMode, ch.type AS callType
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    LEFT JOIN callsHistory ch ON m.callId = ch.callId
    WHERE m.conversationId = ?
      AND (
        (m.type IN ('incoming', 'outgoing') AND m.body IS NOT NULL AND m.body != '')
        OR m.type = 'call-history'
      )
    ORDER BY m.sent_at DESC
    LIMIT ?
  `);
  const messages = stm.all(conversationId, limit);
  return { conversationName: convName, messages };
}

/**
 * Hnijící zprávy – nepřečtené příchozí bez odpovědi, starší než hoursThreshold hodin.
 * Seskupené podle konverzace (poslední hnijící zpráva za konverzaci), seřazené od nejnovějších.
 */
function getRotting(db, hoursThreshold = 24, limit = 30) {
  const cutoff = Date.now() - hoursThreshold * 60 * 60 * 1000;
  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           c.name AS conversationName, c.e164 AS conversationPhone,
           (SELECT COUNT(*) FROM messages m3
            WHERE m3.conversationId = m.conversationId
              AND (m3.readStatus = 0 OR m3.readStatus IS NULL)
              AND m3.type = 'incoming'
              AND m3.body IS NOT NULL AND m3.body != ''
              AND m3.sent_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM messages m4
                WHERE m4.conversationId = m3.conversationId
                  AND m4.type = 'outgoing'
                  AND m4.sent_at > m3.sent_at
              )
           ) AS rottingCount
    FROM messages m
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE (m.readStatus = 0 OR m.readStatus IS NULL)
      AND m.type = 'incoming'
      AND m.body IS NOT NULL AND m.body != ''
      AND m.sent_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
        WHERE m2.conversationId = m.conversationId
          AND m2.type = 'outgoing'
          AND m2.sent_at > m.sent_at
      )
      AND m.sent_at = (
        SELECT MAX(m5.sent_at) FROM messages m5
        WHERE m5.conversationId = m.conversationId
          AND (m5.readStatus = 0 OR m5.readStatus IS NULL)
          AND m5.type = 'incoming'
          AND m5.body IS NOT NULL AND m5.body != ''
          AND m5.sent_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM messages m6
            WHERE m6.conversationId = m5.conversationId
              AND m6.type = 'outgoing'
              AND m6.sent_at > m5.sent_at
          )
      )
    ORDER BY m.sent_at DESC
    LIMIT ?
  `);
  return stm.all(cutoff, cutoff, cutoff, limit);
}

/**
 * Získat zprávu podle ID.
 * Používá se hlavně po interaktivním výběru výsledku z FTS hledání.
 */
function getMessageById(db, id) {
  const stm = db.prepare(`
    SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
           c.name AS conversationName, c.e164 AS conversationPhone
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
 * Full-text search v těle zpráv (messages_fts).
 * Vrací { messages, total } – total = celkový počet nalezených (bez limitu).
 * options: { limit, from, to } – from/to jsou ISO datum (např. 2025-01-15) nebo timestamp v ms.
 */
function searchMessagesFTS(db, query, limit = 20, options = {}) {
  if (!query || !query.trim()) return { messages: [], total: 0 };
  const ftsQuery = toFTS5Query(query);
  if (!ftsQuery) return { messages: [], total: 0 };

  const fromTs = parseDateToTs(options.from);
  const toTs = parseDateToTs(options.to, true);

  try {
    // Count and result queries intentionally share the same filters so the UI
    // can display both "shown" and "total found" numbers consistently.
    let countSql = `
      SELECT COUNT(*) as total FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
        AND m.body IS NOT NULL AND m.body != ''
    `;
    let countParams = [ftsQuery];
    if (fromTs != null) {
      countSql += ` AND m.sent_at >= ?`;
      countParams.push(fromTs);
    }
    if (toTs != null) {
      countSql += ` AND m.sent_at <= ?`;
      countParams.push(toTs);
    }
    const countStm = db.prepare(countSql);
    const { total } = countStm.get(...countParams);

    let sql = `
      SELECT m.id, m.body, m.sent_at, m.type, m.conversationId,
             c.name AS conversationName, c.e164 AS conversationPhone
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      LEFT JOIN conversations c ON m.conversationId = c.id
      WHERE messages_fts MATCH ?
        AND m.body IS NOT NULL AND m.body != ''
    `;
    let params = [ftsQuery];
    if (fromTs != null) {
      sql += ` AND m.sent_at >= ?`;
      params.push(fromTs);
    }
    if (toTs != null) {
      sql += ` AND m.sent_at <= ?`;
      params.push(toTs);
    }
    sql += ` ORDER BY m.sent_at DESC LIMIT ?`;
    params.push(limit);
    const stm = db.prepare(sql);
    const messages = stm.all(...params);
    return { messages, total };
  } catch (e) {
    return { messages: [], total: 0 };
  }
}

/**
 * Parsuje datum na timestamp (ms).
 * `str` může být ISO datum (2025-01-15) nebo číslo.
 * `endOfDay=true` posouvá horní hranici na konec dne pro inclusive filtr `--to`.
 */
function parseDateToTs(str, endOfDay = false) {
  if (str == null || str === '') return null;
  if (typeof str === 'number') return str;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
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
    SELECT id, name, e164, type, active_at
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
           ch.timestamp, c.name AS conversationName, c.e164 AS conversationPhone
    FROM callsHistory ch
    LEFT JOIN messages m ON m.callId = ch.callId
    LEFT JOIN conversations c ON m.conversationId = c.id
    WHERE ch.timestamp IS NOT NULL
    ORDER BY ch.timestamp DESC
    LIMIT ?
  `);
  return stm.all(limit);
}

module.exports = {
  getFolderPath,
  getDBPath,
  getKey,
  openDB,
  formatDate,
  formatMessage,
  formatCall,
  getUnread,
  getLastMessages,
  findConversations,
  getConversationMessages,
  getRotting,
  getMessageById,
  toFTS5Query,
  searchMessagesFTS,
  getConversations,
  getCalls,
};
