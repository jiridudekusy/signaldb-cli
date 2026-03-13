# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool for browsing a local encrypted Signal Desktop database (read-only). All UI text is in English. The database is opened via SQLCipher (`@signalapp/sqlcipher`).

## Commands

```bash
npm run lint          # ESLint (flat config, ESM)
npm run lint:fix      # ESLint with auto-fix
npm test              # vitest run
npm run test:watch    # vitest in watch mode
```

**Important:** `.npmrc` has `ignore-scripts=true`. When installing/rebuilding native addons, use `--ignore-scripts=false`:
```bash
npm ci --ignore-scripts=false
npm rebuild @signalapp/sqlcipher --ignore-scripts=false
```

Node 24 required (`.nvmrc`). The native addon does not compile on Node 25+.

## Architecture

```
signal-db-cli.js          CLI entrypoint (commander commands, output formatting, decrypt command)
signal-db-mcp.js          MCP server (stdio transport, exposes same queries as CLI)
  └── lib/signal-db.js    Data layer (DB open, SQL queries, formatters)
       └── @signalapp/sqlcipher (SQLCipher)
```

**signal-db-cli.js** registers commands and handles terminal output. It also owns the `decrypt` command which extracts the Signal decryption key on all platforms (macOS Keychain, Linux GNOME Keyring/KWallet, Windows DPAPI) and saves it to `~/.signal-db-cli/.env`. All database logic lives in **lib/signal-db.js** which exports query functions (`getMessages`, `getMessagesWithContext`, `getConversations`, `getCalls`, `findConversations`, `getMessageById`) and pure formatting/utility functions (`formatDate`, `formatMessage`, `formatCall`, `toFTS5Query`, `parseDateToTs`, `mergeContextGroups`).

**signal-db-mcp.js** is an MCP server exposing tools: `get_messages`, `get_conversations`, `get_calls`, `get_message_by_id`, `get_phone`.

The database is always opened read-only. The decryption key comes from `SIGNAL_DECRYPTION_KEY` env var (loaded via dotenv from `.env` or `~/.signal-db-cli/.env`).

## Error handling

`lib/signal-db.js` is the data layer and **throws errors** for all failure conditions (conflicting options, unknown conversations, bad date formats, SQL errors). It never returns error objects — always throws.

Callers are responsible for catching:
- **CLI (`signal-db-cli.js`)**: top-level `parseAsync().catch()` handles all thrown errors and prints them to stderr. Interactive search `source` callbacks catch locally and return empty results (so the search UI doesn't crash).
- **MCP (`signal-db-mcp.js`)**: each tool handler wraps `lib/signal-db.js` calls in try-catch and returns `{ isError: true, content: [{ type: 'text', text: err.message }] }`.

When adding new queries or modifying existing ones in `lib/signal-db.js`, always throw on error — never return `{ error: ... }` objects.

## SQL security

All user values are passed through parameterized queries (`?` placeholders) — never interpolated into SQL strings. Specific safeguards:
- **SQLCipher key**: validated as hex-only string before interpolation into `PRAGMA key` (the only place where string interpolation is used in SQL).
- **LIKE patterns**: `findConversations()` escapes `%`, `_`, `\` in user input with `ESCAPE '\'` clause.
- **FTS5 queries**: `toFTS5Query()` output is passed via `MATCH ?` (parameterized), preventing SQL injection. FTS5 syntax errors propagate as thrown errors.

## Testing

Tests cover only the pure functions (formatters, query builders) that don't require a database connection. Importing `lib/signal-db.js` loads the native SQLCipher module but doesn't open any database, so tests work without the Signal DB present.

Both source and test files use ESM (`import`/`export`). The project has `"type": "module"` in package.json.

## FTS5 Query Syntax

`toFTS5Query()` converts user-friendly syntax: spaces = OR, commas = AND, each term gets a `*` suffix for prefix matching. Example: `"hello world, deadline"` becomes `"(hello* OR world*) AND deadline*"`.

## Conversation ID detection and multi-conv search

`getMessages()` resolves the `--conv` value in three ways:

1. **UUID** — matches `/^[0-9a-f]+(-[0-9a-f]+){3,}$/i` (hex groups separated by dashes, 4+ groups) → treated as a direct conversation ID.
2. **Exact name** — prefix `=` (e.g. `=USY HoT`) → `findConversations(db, name, { exact: true })`, returns exactly one conversation or throws.
3. **Fuzzy name** — everything else → `findConversations(db, name)`, returns all matching conversations. Messages are queried across all matches using `IN (?, ?, ...)` clause.

When multiple conversations match a fuzzy search, `conversationName` is set to `"<query> (<N> conversations)"`.

## Maintenance checklist

**IMPORTANT:** When changing CLI commands, options, or behavior, always update these files:

1. **`docs/MANUAL.md`** — end-user documentation. Must reflect the current CLI surface (commands, options, examples). Written in English.
2. **This file (`CLAUDE.md`)** — update the Architecture section (export list, tool list), Error handling, or any other section that describes the changed behavior.
3. **`AGENTS.md`** — keep aligned with this file. If you change guidance here, mirror it there.
4. **`test/mcp.test.js`** — if MCP tools are added/removed, update the tool count assertion (`'registers all N tools'`) and add/remove the corresponding test.
5. **`test/AI_MANUAL_TESTING.md`** — manual test cases for AI-assisted testing. When adding or changing CLI features, add corresponding test scenarios.
6. **Node version** — pinned in `.nvmrc`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, this file, `AGENTS.md`, and `docs/MANUAL.md`. Change all at once.
