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
  getMessagesWithContext,
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

/** Render context groups (grep-style -A/-B/-C output). */
function printContextGroups(groups, { multiConv = false } = {}) {
  groups.forEach((group, gi) => {
    if (multiConv) {
      console.log(`--- ${group.conversationName} ---`);
    }
    if (gi > 0 && !multiConv) console.log('--');
    group.messages.forEach((msg) => {
      const fmt = formatMessage(msg);
      const marker = msg.isMatch ? '>' : ' ';
      console.log(`${marker} [${formatDate(msg.sent_at)}] ${fmt.dir} ${fmt.body}`);
    });
    if (multiConv && gi < groups.length - 1) console.log('');
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
  .option('-A, --after <n>', 'show N messages after each match', parseInt)
  .option('-B, --before <n>', 'show N messages before each match', parseInt)
  .option('-C, --context <n>', 'show N messages before and after each match', parseInt)
  .action(async (query, options, cmd) => {
    const opts = cmd.parent ? cmd.parent.opts() : {};
    const limit = opts.limit ?? 20;
    const interactive = opts.interactive;
    const json = opts.json;
    // Resolve -C into before/after
    const ctxBefore = options.before || options.context || 0;
    const ctxAfter = options.after || options.context || 0;
    const hasContext = ctxBefore > 0 || ctxAfter > 0;

    if (hasContext && !query) {
      throw new Error('Context options (-A/-B/-C) require a search query');
    }

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

    const msgOptions = {
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
    };

    // Context mode: fetch matches with surrounding messages
    if (hasContext) {
      const result = getMessagesWithContext(db, { ...msgOptions, before: ctxBefore, after: ctxAfter });

      if (json) {
        output(result, { json: true });
        return;
      }

      const parts = [];
      if (convFilter) parts.push(result.conversationName || convFilter);
      if (query) parts.push(`"${query}"`);
      if (options.incoming) parts.push('incoming');
      if (options.outgoing) parts.push('outgoing');
      console.log(`\n--- ${parts.join(' | ')} (${result.total} matches) ---\n`);

      if (result.groups.length === 0) return;

      const convIds = new Set(result.groups.map((g) => g.messages[0]?.conversationId));
      printContextGroups(result.groups, { multiConv: convIds.size > 1 });
      return;
    }

    const result = getMessages(db, msgOptions);

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

// --- Decrypt helpers (platform-specific) ---

/** Retrieve Signal password from Linux keyring (GNOME Keyring or KWallet). */
function getLinuxKeyringPassword(execSync) {
  for (const appName of ['signal', 'Signal']) {
    try {
      const pw = execSync(`secret-tool lookup application ${appName}`, {
        encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (pw) return pw;
    } catch { /* try next */ }
  }
  try {
    const pw = execSync(
      'kwallet-query -r "Signal Safe Storage" kdewallet',
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (pw) return pw;
  } catch { /* not KDE */ }
  console.error(
    'Cannot retrieve Signal password from keyring.\n\n' +
    'For GNOME Keyring, install libsecret-tools:\n' +
    '  sudo apt install libsecret-tools\n' +
    '  secret-tool lookup application signal\n\n' +
    'For KDE KWallet:\n' +
    '  kwallet-query -r "Signal Safe Storage" kdewallet',
  );
  process.exit(1);
}

/** Decrypt a DPAPI-protected buffer via PowerShell (Windows). */
function dpapiDecrypt(execSync, buf) {
  // Base64 charset [A-Za-z0-9+/=] is safe inside a PowerShell single-quoted string
  const b64 = buf.toString('base64');
  const psCommand =
    'Add-Type -AssemblyName System.Security; ' +
    '[Convert]::ToBase64String(' +
    '[System.Security.Cryptography.ProtectedData]::Unprotect(' +
    `[Convert]::FromBase64String('${b64}'),` +
    '$null,' +
    '[System.Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psCommand}"`,
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  return Buffer.from(result, 'base64');
}

/** Windows AES-256-GCM decryption with DPAPI-protected master key (Chromium os_crypt v10/v11). */
function decryptWindowsAesGcm(crypto, execSync, fs, encBuf, signalDir) {
  const localStatePath = path.join(signalDir, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    console.error(`Local State not found: ${localStatePath}`);
    process.exit(1);
  }
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const masterKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!masterKeyB64) {
    console.error('No os_crypt.encrypted_key in Local State');
    process.exit(1);
  }
  const masterKeyRaw = Buffer.from(masterKeyB64, 'base64');
  if (masterKeyRaw.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    console.error('Unexpected master key prefix (expected "DPAPI")');
    process.exit(1);
  }
  const masterKey = dpapiDecrypt(execSync, masterKeyRaw.subarray(5));
  if (masterKey.length !== 32) {
    console.error(`Master key is ${masterKey.length} bytes, expected 32`);
    process.exit(1);
  }
  // encBuf layout: [3B prefix][12B nonce][ciphertext][16B GCM tag]
  const nonce = encBuf.subarray(3, 15);
  const ciphertextAndTag = encBuf.subarray(15);
  const authTag = ciphertextAndTag.subarray(-16);
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Extract the SQLCipher decryption key and save it to ~/.signal-db-cli/.env.
program
  .command('decrypt')
  .description('Extract decryption key from Signal Desktop and save to ~/.signal-db-cli/.env')
  .action(async () => {
    const crypto = await import('crypto');
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const plat = process.platform;

    // 1. Find Signal data directory
    const signalDir = process.env.SIGNAL_DIR || (() => {
      if (plat === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Signal');
      if (plat === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Signal');
      if (plat === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Signal');
      console.error(`Unsupported platform: ${plat}`);
      process.exit(1);
    })();

    // 2. Read config.json
    const configPath = path.join(signalDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      console.error(`Signal config not found: ${configPath}`);
      if (plat === 'linux') {
        console.error(
          'Standard locations:\n' +
          '  ~/.config/Signal/config.json\n' +
          '  ~/.var/app/org.signal.Signal/config/Signal/config.json  (Flatpak)',
        );
      }
      process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // 3. Extract key
    let key;
    if (config.key) {
      // Plaintext key (legacy or already decrypted)
      key = config.key;
    } else if (!config.encryptedKey) {
      console.error('No "encryptedKey" or "key" found in config.json');
      process.exit(1);
    } else {
      const encBuf = Buffer.from(config.encryptedKey, 'hex');
      const prefix = encBuf.subarray(0, 3).toString('ascii');

      if (plat === 'darwin') {
        // macOS: AES-128-CBC with Keychain password, PBKDF2 1003 iterations
        if (prefix !== 'v10') {
          console.error(`Unexpected prefix: "${prefix}" (expected "v10")`);
          process.exit(1);
        }
        const keychainPassword = execSync(
          'security find-generic-password -s "Signal Safe Storage" -w',
          { encoding: 'utf8' },
        ).trim();
        const derivedKey = crypto.pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, 0x20);
        const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
        key = Buffer.concat([decipher.update(encBuf.subarray(3)), decipher.final()]).toString('utf8');

      } else if (plat === 'linux') {
        // Linux: v10 = "peanuts" password, v11 = keyring password; PBKDF2 1 iteration
        let password;
        if (prefix === 'v10') {
          password = 'peanuts';
        } else if (prefix === 'v11') {
          password = getLinuxKeyringPassword(execSync);
        } else {
          console.error(`Unknown prefix: "${prefix}" (expected "v10" or "v11")`);
          process.exit(1);
        }
        const derivedKey = crypto.pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
        const iv = Buffer.alloc(16, 0x20);
        const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv);
        key = Buffer.concat([decipher.update(encBuf.subarray(3)), decipher.final()]).toString('utf8');

      } else if (plat === 'win32') {
        // Windows: v10/v11 = AES-256-GCM with DPAPI master key, older = DPAPI directly
        if (prefix === 'v10' || prefix === 'v11') {
          key = decryptWindowsAesGcm(crypto, execSync, fs, encBuf, signalDir);
        } else {
          key = dpapiDecrypt(execSync, encBuf).toString('utf8');
        }
      }
    }

    // 4. Save to ~/.signal-db-cli/.env
    const envDir = path.join(os.homedir(), '.signal-db-cli');
    const envPath = path.join(envDir, '.env');
    fs.mkdirSync(envDir, { recursive: true });

    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
      if (/^SIGNAL_DECRYPTION_KEY=.*/m.test(content)) {
        content = content.replace(/^SIGNAL_DECRYPTION_KEY=.*/m, `SIGNAL_DECRYPTION_KEY=${key}`);
      } else {
        content = content.trimEnd() + `\nSIGNAL_DECRYPTION_KEY=${key}\n`;
      }
    } else {
      content = `SIGNAL_DECRYPTION_KEY=${key}\n`;
    }
    fs.writeFileSync(envPath, content);
    console.log(`Decryption key saved to ${envPath}`);
  });

program.parseAsync().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
