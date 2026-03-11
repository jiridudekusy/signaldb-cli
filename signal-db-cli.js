#!/usr/bin/env node
'use strict';

/**
 * CLI entrypoint for browsing a local Signal Desktop database.
 *
 * Responsibilities in this file:
 * - load env configuration from local and global locations
 * - register commander commands and shared global flags
 * - format terminal output for human-readable and JSON modes
 *
 * Database access and SQL queries live in `lib/signal-db.js`.
 */

const os = require('os');
const path = require('path');
const { Command } = require('commander');
const pkg = require('./package.json');

require('dotenv').config({ quiet: true }); // local .env first
require('dotenv').config({ path: path.join(os.homedir(), '.signal-db-cli', '.env'), quiet: true }); // fallback to global

const {
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
  searchMessagesFTS,
  getConversations,
  getCalls,
} = require('./lib/signal-db');

/** Exit early when a DB-backed command is invoked without the decryption key. */
function checkEnv() {
  if (!process.env.SIGNAL_DECRYPTION_KEY) {
    console.error('Chybí SIGNAL_DECRYPTION_KEY v .env');
    process.exit(1);
  }
}

/**
 * Render a mixed message timeline in a consistent terminal format.
 *
 * Options allow callers to reuse the same renderer for:
 * - global timelines with conversation labels
 * - per-conversation views with direction arrows
 * - unread views with a hint that a call happened afterwards
 */
function printMessages(messages, options = {}) {
  const { showConv = true, showDir = false, showCallAfter = false } = options;
  messages.forEach((msg, i) => {
    const label = showConv ? `${msg.conversationName || msg.conversationPhone || msg.conversationId}` : '';
    if (msg.type === 'call-history') {
      const callStr = formatCall(msg);
      console.log(`${i + 1}. [${formatDate(msg.sent_at)}] ${label ? label + ': ' : ''}${callStr}`);
    } else {
      const fmt = formatMessage(msg);
      const prefix = showDir ? `${fmt.dir} ` : '';
      const callHint = showCallAfter && msg.has_call_after ? ' 📞 call proběhl' : '';
      console.log(`${i + 1}. [${formatDate(msg.sent_at)}] ${label ? label + ': ' : ''}${prefix}${fmt.body}${callHint}`);
    }
  });
}

/** Emit JSON only when requested, while keeping the raw data available to callers. */
function output(data, options) {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  }
  return data;
}

const program = new Command();

program
  .name('signal-db-cli')
  .description('CLI pro práci s lokální Signal databází')
  .version(pkg.version, '-V, --version', 'zobrazit verzi')
  .option('-i, --interactive', 'interaktivní výběr (Inquirer)')
  .option('--json', 'výstup jako JSON')
  .option('-n, --limit <number>', 'limit výsledků', parseInt)
  .hook('preAction', async (_parentCommand, actionCommand) => {
    // Keep update checks centralized so every command behaves the same way.
    if (!process.env.NO_UPDATE_NOTIFIER) {
      try {
        const { default: updateNotifier } = await import('update-notifier');
        const notifier = updateNotifier({
          pkg,
          updateCheckInterval: 1000 * 60 * 60 * 24,
        });
        notifier.notify();
      } catch (e) {
        // Ignore update check errors
      }
    }

    // Commands that don't need the decryption key skip the env check.
    const cmdName = actionCommand.name();
    if (cmdName !== 'decrypt' && cmdName !== 'manual') {
      checkEnv();
    }
  });

// Inbox-style view: unread incoming messages with a call-follow-up hint.
program
  .command('unread')
  .description('Nepřečtené příchozí zprávy')
  .argument('[n]', 'počet zpráv', (v) => parseInt(v, 10) || 50)
  .action(async (n, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? n ?? 50;
    const json = opts.json;
    const db = openDB();
    const { total, messages } = getUnread(db, limit);
    if (json) {
      output({ total, messages }, { json: true });
      return;
    }
    console.log('\n--- Nepřečtené příchozí zprávy ---');
    console.log(`Celkem: ${total} (zobrazeno ${messages.length})`);
    console.log('📞 = proběhl call po zprávě → reakce možná není potřeba\n');
    printMessages(messages, { showCallAfter: true });
  });

// Recent activity feed across all conversations.
program
  .command('last')
  .description('Posledních n zpráv ze všech konverzací')
  .argument('[n]', 'počet zpráv', (v) => parseInt(v, 10) || 20)
  .action(async (n, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? n ?? 20;
    const json = opts.json;
    const db = openDB();
    const messages = getLastMessages(db, limit);
    if (json) {
      output({ messages }, { json: true });
      return;
    }
    console.log(`\n--- Posledních ${messages.length} zpráv ---\n`);
    printMessages(messages);
  });

// Conversation timeline by fuzzy name match, explicit ID, or interactive picker.
program
  .command('conv')
  .description('Posledních n zpráv z konverzace')
  .argument('[query]', 'část názvu konverzace nebo ID')
  .argument('[n]', 'počet zpráv', (v) => parseInt(v, 10) || 10)
  .action(async (query, n, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? n ?? 10;
    const interactive = opts.interactive;
    const json = opts.json;
    const db = openDB();

    let resolvedQuery = query;
    if (interactive || !query) {
      const { search } = require('@inquirer/prompts');
      const convs = getConversations(db, { limit: 100 });
      const choices = convs.map((c) => ({
        value: c.id,
        name: c.name || c.e164 || c.id,
        description: c.type,
      }));
      resolvedQuery = await search({
        message: 'Vyber konverzaci',
        source: async (input) => {
          if (!input) return choices.slice(0, 20);
          const q = input.toLowerCase();
          return choices.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 20);
        },
      });
    }

    if (!resolvedQuery) {
      console.error('Použití: conv <jméno nebo ID konverzace> [počet]');
      process.exit(1);
    }

    const result = getConversationMessages(db, resolvedQuery, limit);
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (json) {
      output(result, { json: true });
      return;
    }
    console.log(`\n--- ${result.conversationName || resolvedQuery}: posledních ${result.messages.length} položek (zprávy + hovory) ---\n`);
    printMessages(result.messages, { showConv: false, showDir: true });
  });

// Lightweight search over conversation metadata only.
program
  .command('search')
  .description('Vyhledat konverzace podle názvu')
  .argument('<query>', 'část názvu')
  .action(async (query, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const json = opts.json;
    const db = openDB();
    const convs = findConversations(db, query);
    if (json) {
      output({ conversations: convs }, { json: true });
      return;
    }
    if (convs.length === 0) {
      console.log(`Žádná konverzace neodpovídá "${query}"`);
      return;
    }
    console.log(`\n--- Konverzace odpovídající "${query}" ---\n`);
    convs.forEach((c) => {
      console.log(`  ${c.name || c.e164 || '(bez názvu)'}  [${c.id}]`);
    });
  });

// Message-body search backed by the SQLite FTS index.
program
  .command('search-msg')
  .description('Full-text vyhledávání v těle zpráv')
  .argument('[query]', 'hledaný text (u -i volitelné)')
  .option('--from <date>', 'od data (ISO např. 2025-01-15)')
  .option('--to <date>', 'do data (ISO např. 2025-02-17)')
  .action(async (query, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 20;
    const interactive = opts.interactive;
    const json = opts.json;
    const db = openDB();
    const searchOpts = { from: options.from, to: options.to };

    if (interactive || !query) {
      const { search, Separator } = require('@inquirer/prompts');
      const msgId = await search({
        message: 'Hledat v zprávách (piš – výsledky se zobrazují živě)',
        source: async (input, { signal }) => {
          if (!input || input.trim().length < 2) {
            return [];
          }
          const { messages: msgs, total } = searchMessagesFTS(db, input.trim(), limit, searchOpts);
          if (msgs.length === 0) {
            return [];
          }
          return [
            new Separator(`Nalezeno ${total} zpráv (zobrazeno ${msgs.length})`),
            ...msgs.map((m) => ({
              value: m.id,
              name: `${formatDate(m.sent_at)} ${(m.conversationName || m.conversationId)}: ${(m.body || '').slice(0, 50)}...`,
              description: (m.body || '').slice(0, 100),
            })),
          ];
        },
      });
      if (msgId) {
        const msg = getMessageById(db, msgId);
        if (msg) {
          console.log(`\n--- Zpráva ---`);
          console.log(`Konverzace: ${msg.conversationName || msg.conversationId}`);
          console.log(`Datum: ${formatDate(msg.sent_at)}`);
          console.log(`\n${msg.body}`);
        }
      }
      return;
    }

    const { messages, total } = searchMessagesFTS(db, query, limit, searchOpts);
    if (json) {
      output({ messages, total }, { json: true });
      return;
    }
    if (messages.length === 0) {
      console.log(`Žádné zprávy neobsahují "${query}"`);
      return;
    }
    console.log(`\n--- Zprávy obsahující "${query}" (nalezeno ${total}, zobrazeno ${messages.length}) ---\n`);
    printMessages(messages);
  });

// Conversation inventory with optional private/group filtering.
program
  .command('convs')
  .description('Seznam konverzací')
  .option('-t, --type <type>', 'filtr: private | group')
  .action(async (options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 50;
    const json = opts.json;
    const db = openDB();
    const convs = getConversations(db, { type: options.type || null, limit });
    if (json) {
      output({ conversations: convs }, { json: true });
      return;
    }
    console.log(`\n--- Konverzace (${convs.length}) ---\n`);
    convs.forEach((c, i) => {
      console.log(`${i + 1}. ${c.name || c.e164 || '(bez názvu)'}  [${c.type}]  ${formatDate(c.active_at)}`);
    });
  });

// Call history shown independently from message timelines.
program
  .command('calls')
  .description('Historie hovorů')
  .argument('[n]', 'počet hovorů', (v) => parseInt(v, 10) || 20)
  .action(async (n, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? n ?? 20;
    const json = opts.json;
    const db = openDB();
    const calls = getCalls(db, limit);
    if (json) {
      output({ calls }, { json: true });
      return;
    }
    console.log(`\n--- Posledních ${calls.length} hovorů ---\n`);
    calls.forEach((c, i) => {
      const dir = (c.direction || '').toLowerCase() === 'incoming' ? '↓' : '↑';
      console.log(`${i + 1}. [${formatDate(c.timestamp)}] 📞${dir} ${c.conversationName || c.conversationPhone || '?'}  ${c.status} ${c.mode || ''}`);
    });
  });

// Surfaces old incoming messages that still have no outgoing reply.
program
  .command('rotting')
  .description('Hnijící zprávy (bez odpovědi)')
  .argument('[hodiny]', 'práh v hodinách', (v) => parseInt(v, 10) || 24)
  .action(async (hodiny, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 30;
    const json = opts.json;
    const db = openDB();
    const messages = getRotting(db, hodiny, limit);
    if (json) {
      output({ messages }, { json: true });
      return;
    }
    if (messages.length === 0) {
      console.log(`\n--- Žádné hnijící zprávy (práh: ${hodiny}h) ---\n`);
      return;
    }
    console.log(`\n--- Hnijící zprávy (bez odpovědi, starší než ${hodiny}h) ---`);
    console.log(`Konverzací: ${messages.length}\n`);
    messages.forEach((msg, i) => {
      const fmt = formatMessage(msg);
      const age = Math.round((Date.now() - msg.sent_at) / (1000 * 60 * 60));
      const label = msg.conversationName || msg.conversationPhone || msg.conversationId;
      const count = msg.rottingCount > 1 ? ` (${msg.rottingCount} zpráv)` : '';
      console.log(`${i + 1}. [${formatDate(msg.sent_at)}] (${age}h) ${label}${count}: ${fmt.body}`);
    });
  });

// Shortcut menu for the most common interactive workflows.
program
  .command('interactive')
  .alias('i')
  .description('Interaktivní režim – hlavní menu')
  .action(async () => {
    const { select } = require('@inquirer/prompts');
    const db = openDB();
    const choice = await select({
      message: 'Co chceš dělat?',
      choices: [
        { value: 'unread', name: 'Nepřečtené zprávy' },
        { value: 'last', name: 'Poslední zprávy' },
        { value: 'conv', name: 'Konverzace – zprávy z vybrané konverzace' },
        { value: 'search-msg', name: 'Hledat v zprávách' },
        { value: 'calls', name: 'Historie hovorů' },
        { value: 'rotting', name: 'Hnijící zprávy' },
      ],
    });
    if (choice === 'unread') {
      const limit = 50;
      const { total, messages } = getUnread(db, limit);
      console.log('\n--- Nepřečtené příchozí zprávy ---');
      console.log(`Celkem: ${total} (zobrazeno ${messages.length})\n`);
      printMessages(messages, { showCallAfter: true });
    } else if (choice === 'last') {
      const messages = getLastMessages(db, 20);
      console.log('\n--- Posledních 20 zpráv ---\n');
      printMessages(messages);
    } else if (choice === 'conv') {
      const { search } = require('@inquirer/prompts');
      const convs = getConversations(db, { limit: 100 });
      const choices = convs.map((c) => ({
        value: c.id,
        name: c.name || c.e164 || c.id,
      }));
      const convId = await search({
        message: 'Vyber konverzaci (piš pro filtrování)',
        source: async (input) => {
          if (!input) return choices.slice(0, 25);
          const q = input.toLowerCase();
          return choices.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 25);
        },
      });
      const result = getConversationMessages(db, convId, 15);
      if (result.error) {
        console.error(result.error);
      } else {
        console.log(`\n--- ${result.conversationName || convId} ---\n`);
        printMessages(result.messages, { showConv: false, showDir: true });
      }
    } else if (choice === 'search-msg') {
      const { search, Separator } = require('@inquirer/prompts');
      const msgId = await search({
        message: 'Hledat v zprávách (piš – výsledky se zobrazují živě)',
        source: async (input) => {
          if (!input || input.trim().length < 2) {
            return [];
          }
          const { messages: msgs, total } = searchMessagesFTS(db, input.trim(), 15);
          if (msgs.length === 0) {
            return [];
          }
          return [
            new Separator(`Nalezeno ${total} zpráv (zobrazeno ${msgs.length})`),
            ...msgs.map((m) => ({
              value: m.id,
              name: `${formatDate(m.sent_at)} ${(m.conversationName || m.conversationId)}: ${(m.body || '').slice(0, 50)}...`,
              description: (m.body || '').slice(0, 100),
            })),
          ];
        },
      });
      if (msgId) {
        const msg = getMessageById(db, msgId);
        if (msg) {
          console.log(`\n--- Zpráva ---`);
          console.log(`Konverzace: ${msg.conversationName || msg.conversationId}`);
          console.log(`Datum: ${formatDate(msg.sent_at)}`);
          console.log(`\n${msg.body}`);
        }
      }
    } else if (choice === 'calls') {
      const calls = getCalls(db, 20);
      console.log('\n--- Posledních 20 hovorů ---\n');
      calls.forEach((c, i) => {
        const dir = (c.direction || '').toLowerCase() === 'incoming' ? '↓' : '↑';
        console.log(`${i + 1}. [${formatDate(c.timestamp)}] 📞${dir} ${c.conversationName || '?'}  ${c.status}`);
      });
    } else if (choice === 'rotting') {
      const messages = getRotting(db, 24);
      if (messages.length === 0) {
        console.log('\nŽádné hnijící zprávy.');
      } else {
        console.log('\n--- Hnijící zprávy ---\n');
        messages.forEach((msg, i) => {
          const fmt = formatMessage(msg);
          console.log(`${i + 1}. ${msg.conversationName || msg.conversationId}: ${fmt.body}`);
        });
      }
    }
  });

// Print the bundled manual directly from the repository.
program
  .command('manual')
  .description('Rozšířená dokumentace')
  .action(async () => {
    const fs = require('fs');
    const manualPath = path.join(__dirname, 'docs', 'MANUAL.md');
    if (fs.existsSync(manualPath)) {
      console.log(fs.readFileSync(manualPath, 'utf8'));
    } else {
      console.log('Soubor docs/MANUAL.md nenalezen.');
    }
  });

// Extract the SQLCipher decryption key from Signal Desktop's config.
program
  .command('decrypt')
  .description('Zjistit dešifrovací klíč z Signal Desktop (macOS)')
  .action(async () => {
    const crypto = require('crypto');
    const { execSync } = require('child_process');
    const fs = require('fs');

    const signalDir =
      process.env.SIGNAL_DIR ||
      path.join(os.homedir(), 'Library', 'Application Support', 'Signal');
    const configPath = path.join(signalDir, 'config.json');

    if (!fs.existsSync(configPath)) {
      console.error(`Signal config nenalezen: ${configPath}`);
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (config.key) {
      console.log(config.key);
      return;
    }

    if (!config.encryptedKey) {
      console.error('No encryptedKey or key found in config.json');
      process.exit(1);
    }

    const encryptedBuf = Buffer.from(config.encryptedKey, 'hex');
    const prefix = encryptedBuf.slice(0, 3).toString('ascii');

    if (prefix !== 'v10') {
      console.error(`Unexpected prefix: "${prefix}" (expected "v10")`);
      process.exit(1);
    }

    const keychainPassword = execSync(
      'security find-generic-password -s "Signal Safe Storage" -w',
      { encoding: 'utf8' }
    ).trim();

    const derivedKey = crypto.pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const ciphertext = encryptedBuf.slice(3);

    const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    console.log(plaintext.toString('utf8'));
  });

program.parseAsync().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
