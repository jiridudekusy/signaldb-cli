#!/usr/bin/env node

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

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import dotenv from 'dotenv';
import pkg from './package.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ quiet: true }); // local .env first
dotenv.config({ path: path.join(os.homedir(), '.signal-db-cli', '.env'), quiet: true }); // fallback to global

import {
  openDB,
  formatDate,
  formatMessage,
  formatCall,
  getMessages,
  findConversations,
  getMessageById,
  getConversations,
  getCalls,
} from './lib/signal-db.js';

/** Exit early when a DB-backed command is invoked without the decryption key. */
function checkEnv() {
  if (!process.env.SIGNAL_DECRYPTION_KEY) {
    console.error('Missing SIGNAL_DECRYPTION_KEY in .env');
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
      const callHint = showCallAfter && msg.has_call_after ? ' 📞 call made' : '';
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
  .description('CLI for browsing a local Signal Desktop database')
  .version(pkg.version, '-V, --version', 'show version')
  .option('-i, --interactive', 'interactive mode (Inquirer)')
  .option('--json', 'output as JSON')
  .option('-n, --limit <number>', 'limit results', parseInt)
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
      } catch {
        // Ignore update check errors
      }
    }

    // Commands that don't need the decryption key skip the env check.
    const cmdName = actionCommand.name();
    if (cmdName !== 'decrypt' && cmdName !== 'manual') {
      checkEnv();
    }
  });

// Unified message query with composable filters.
program
  .command('messages')
  .alias('msg')
  .description('Messages with filters (full-text, conversation, unread, unanswered, date)')
  .argument('[query]', 'full-text search in message body')
  .option('--conv <name>', 'conversation filter (name, =exact name, or UUID)')
  .option('--unread', 'only unread incoming')
  .option('--unanswered [hours]', 'unanswered, older than N hours (default 24)')
  .option('--from <date>', 'from date (ISO e.g. 2025-01-15)')
  .option('--to <date>', 'to date (ISO e.g. 2025-02-17)')
  .option('--incoming', 'only incoming')
  .option('--outgoing', 'only outgoing')
  .action(async (query, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 20;
    const interactive = opts.interactive;
    const json = opts.json;
    const db = openDB();

    // Interactive conversation picker when --conv used with -i or without value
    let convFilter = options.conv;
    if (interactive && !convFilter) {
      const { search } = await import('@inquirer/prompts');
      const convs = getConversations(db, { limit: 100 });
      const choices = convs.map((c) => ({
        value: c.id,
        name: c.name || c.e164 || c.id,
        description: c.type,
      }));
      convFilter = await search({
        message: 'Select conversation',
        source: async (input) => {
          if (!input) return choices.slice(0, 20);
          const q = input.toLowerCase();
          return choices.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 20);
        },
      });
    }

    // Interactive FTS search when -i and no query
    if (interactive && !query && !options.unread && !options.unanswered && !convFilter) {
      const { search, Separator } = await import('@inquirer/prompts');
      const msgId = await search({
        message: 'Search messages (type – results appear live)',
        source: async (input) => {
          if (!input || input.trim().length < 2) return [];
          try {
            const result = getMessages(db, { search: input.trim(), from: options.from, to: options.to, limit });
            if (result.messages.length === 0) return [];
            return [
              new Separator(`Found ${result.total} messages (showing ${result.messages.length})`),
              ...result.messages.map((m) => ({
                value: m.id,
                name: `${formatDate(m.sent_at)} ${(m.conversationName || m.conversationId)}: ${(m.body || '').slice(0, 50)}...`,
                description: (m.body || '').slice(0, 100),
              })),
            ];
          } catch {
            return [];
          }
        },
      });
      if (msgId) {
        const msg = getMessageById(db, msgId);
        if (msg) {
          console.log(`\n--- Message ---`);
          console.log(`Conversation: ${msg.conversationName || msg.conversationId}`);
          console.log(`Date: ${formatDate(msg.sent_at)}`);
          console.log(`\n${msg.body}`);
        }
      }
      return;
    }

    const unansweredHours = options.unanswered === true ? 24 : parseInt(options.unanswered, 10) || undefined;

    const result = getMessages(db, {
      conv: convFilter,
      unread: options.unread || false,
      unanswered: !!options.unanswered,
      olderThan: unansweredHours,
      search: query,
      from: options.from,
      to: options.to,
      incoming: options.incoming || false,
      outgoing: options.outgoing || false,
      limit,
    });

    if (json) {
      output(result, { json: true });
      return;
    }

    // Build header
    const parts = [];
    if (options.unread) parts.push('unread');
    if (options.unanswered) parts.push(`unanswered (>${unansweredHours || 24}h)`);
    if (convFilter) parts.push(result.conversationName || convFilter);
    if (query) parts.push(`"${query}"`);
    if (options.incoming) parts.push('incoming');
    if (options.outgoing) parts.push('outgoing');
    const header = parts.length > 0 ? parts.join(' | ') : 'recent messages';
    console.log(`\n--- ${header} (${result.messages.length}/${result.total}) ---\n`);

    if (result.messages.length === 0) return;

    // Render options based on active filters
    const showConv = !convFilter;
    const showDir = !!convFilter;
    const showCallAfter = !!options.unread;

    if (options.unanswered) {
      result.messages.forEach((msg, i) => {
        const fmt = formatMessage(msg);
        const age = Math.round((Date.now() - msg.sent_at) / (1000 * 60 * 60));
        const label = msg.conversationName || msg.conversationPhone || msg.conversationId;
        const count = msg.rottingCount > 1 ? ` (${msg.rottingCount} messages)` : '';
        console.log(`${i + 1}. [${formatDate(msg.sent_at)}] (${age}h) ${label}${count}: ${fmt.body}`);
      });
    } else {
      printMessages(result.messages, { showConv, showDir, showCallAfter });
    }
  });

// Conversation inventory with optional search/filtering.
program
  .command('convs')
  .description('List conversations')
  .argument('[query]', 'search conversations by name')
  .option('-t, --type <type>', 'filter: private | group')
  .action(async (query, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 50;
    const json = opts.json;
    const db = openDB();

    if (query) {
      const convs = findConversations(db, query);
      if (json) {
        output({ conversations: convs }, { json: true });
        return;
      }
      if (convs.length === 0) {
        console.log(`No conversation matches "${query}"`);
        return;
      }
      console.log(`\n--- Conversations matching "${query}" ---\n`);
      convs.forEach((c) => {
        console.log(`  ${c.name || c.e164 || '(unnamed)'}  [${c.id}]`);
      });
      return;
    }

    const convs = getConversations(db, { type: options.type || null, limit });
    if (json) {
      output({ conversations: convs }, { json: true });
      return;
    }
    console.log(`\n--- Conversations (${convs.length}) ---\n`);
    convs.forEach((c, i) => {
      console.log(`${i + 1}. ${c.name || c.e164 || '(unnamed)'}  [${c.type}]  ${formatDate(c.active_at)}`);
    });
  });

// Phone number lookup by contact name.
program
  .command('phone')
  .description('Look up phone number by name')
  .argument('<query>', 'contact name')
  .action(async (query, _options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const json = opts.json;
    const db = openDB();
    const convs = findConversations(db, query).filter((c) => c.e164);
    if (json) {
      output({ contacts: convs.map((c) => ({ name: c.name, phone: c.e164 })) }, { json: true });
      return;
    }
    if (convs.length === 0) {
      console.log(`No contact with phone number matches "${query}"`);
      return;
    }
    console.log(`\n--- Contacts for "${query}" ---\n`);
    convs.forEach((c) => {
      console.log(`  ${c.name || '(unnamed)'}  ${c.e164}`);
    });
  });

// Call history shown independently from message timelines.
program
  .command('calls')
  .description('Call history')
  .argument('[n]', 'number of calls', (v) => parseInt(v, 10) || 20)
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
    console.log(`\n--- Last ${calls.length} calls ---\n`);
    calls.forEach((c, i) => {
      const dir = (c.direction || '').toLowerCase() === 'incoming' ? '↓' : '↑';
      console.log(`${i + 1}. [${formatDate(c.timestamp)}] 📞${dir} ${c.conversationName || c.conversationPhone || '?'}  ${c.status} ${c.mode || ''}`);
    });
  });

// Shortcut menu for the most common interactive workflows.
program
  .command('interactive')
  .alias('i')
  .description('Interactive mode – main menu')
  .action(async () => {
    const { select, search, Separator } = await import('@inquirer/prompts');
    const db = openDB();
    const choice = await select({
      message: 'What do you want to do?',
      choices: [
        { value: 'unread', name: 'Unread messages' },
        { value: 'last', name: 'Recent messages' },
        { value: 'conv', name: 'Conversations – messages from a selected conversation' },
        { value: 'search', name: 'Search messages' },
        { value: 'unanswered', name: 'Unanswered' },
        { value: 'calls', name: 'Call history' },
      ],
    });
    if (choice === 'unread') {
      const result = getMessages(db, { unread: true, limit: 50 });
      console.log('\n--- Unread incoming messages ---');
      console.log(`Total: ${result.total} (showing ${result.messages.length})\n`);
      printMessages(result.messages, { showCallAfter: true });
    } else if (choice === 'last') {
      const result = getMessages(db, { limit: 20 });
      console.log(`\n--- Last ${result.messages.length} messages ---\n`);
      printMessages(result.messages);
    } else if (choice === 'conv') {
      const convs = getConversations(db, { limit: 100 });
      const choices = convs.map((c) => ({
        value: c.id,
        name: c.name || c.e164 || c.id,
      }));
      const convId = await search({
        message: 'Select conversation (type to filter)',
        source: async (input) => {
          if (!input) return choices.slice(0, 25);
          const q = input.toLowerCase();
          return choices.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 25);
        },
      });
      const result = getMessages(db, { conv: convId, limit: 15 });
      console.log(`\n--- ${result.conversationName || convId} ---\n`);
      printMessages(result.messages, { showConv: false, showDir: true });
    } else if (choice === 'search') {
      const msgId = await search({
        message: 'Search messages (type – results appear live)',
        source: async (input) => {
          if (!input || input.trim().length < 2) return [];
          try {
            const result = getMessages(db, { search: input.trim(), limit: 15 });
            if (result.messages.length === 0) return [];
            return [
              new Separator(`Found ${result.total} messages (showing ${result.messages.length})`),
              ...result.messages.map((m) => ({
                value: m.id,
                name: `${formatDate(m.sent_at)} ${(m.conversationName || m.conversationId)}: ${(m.body || '').slice(0, 50)}...`,
                description: (m.body || '').slice(0, 100),
              })),
            ];
          } catch {
            return [];
          }
        },
      });
      if (msgId) {
        const msg = getMessageById(db, msgId);
        if (msg) {
          console.log(`\n--- Message ---`);
          console.log(`Conversation: ${msg.conversationName || msg.conversationId}`);
          console.log(`Date: ${formatDate(msg.sent_at)}`);
          console.log(`\n${msg.body}`);
        }
      }
    } else if (choice === 'unanswered') {
      const result = getMessages(db, { unanswered: true, olderThan: 24, limit: 30 });
      if (result.messages.length === 0) {
        console.log('\nNo unanswered messages.');
      } else {
        console.log('\n--- Unanswered ---\n');
        result.messages.forEach((msg, idx) => {
          const fmt = formatMessage(msg);
          const age = Math.round((Date.now() - msg.sent_at) / (1000 * 60 * 60));
          const label = msg.conversationName || msg.conversationPhone || msg.conversationId;
          const count = msg.rottingCount > 1 ? ` (${msg.rottingCount} messages)` : '';
          console.log(`${idx + 1}. [${formatDate(msg.sent_at)}] (${age}h) ${label}${count}: ${fmt.body}`);
        });
      }
    } else if (choice === 'calls') {
      const calls = getCalls(db, 20);
      console.log('\n--- Last 20 calls ---\n');
      calls.forEach((c, idx) => {
        const dir = (c.direction || '').toLowerCase() === 'incoming' ? '↓' : '↑';
        console.log(`${idx + 1}. [${formatDate(c.timestamp)}] 📞${dir} ${c.conversationName || '?'}  ${c.status}`);
      });
    }
  });

// Print the bundled manual directly from the repository.
program
  .command('manual')
  .description('Extended documentation')
  .action(async () => {
    const fs = await import('fs');
    const manualPath = path.join(__dirname, 'docs', 'MANUAL.md');
    if (fs.existsSync(manualPath)) {
      console.log(fs.readFileSync(manualPath, 'utf8'));
    } else {
      console.log('File docs/MANUAL.md not found.');
    }
  });

// Extract the SQLCipher decryption key from Signal Desktop's config.
program
  .command('decrypt')
  .description('Extract decryption key from Signal Desktop (macOS)')
  .action(async () => {
    const crypto = await import('crypto');
    const { execSync } = await import('child_process');
    const fs = await import('fs');

    const signalDir =
      process.env.SIGNAL_DIR ||
      path.join(os.homedir(), 'Library', 'Application Support', 'Signal');
    const configPath = path.join(signalDir, 'config.json');

    if (!fs.existsSync(configPath)) {
      console.error(`Signal config not found: ${configPath}`);
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
