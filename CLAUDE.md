# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool for browsing a local encrypted Signal Desktop database (read-only). All UI text is in Czech. The database is opened via SQLCipher (`@signalapp/better-sqlite3`).

## Commands

```bash
npm run lint          # ESLint (flat config, CJS)
npm run lint:fix      # ESLint with auto-fix
npm test              # vitest run
npm run test:watch    # vitest in watch mode
```

**Important:** `.npmrc` has `ignore-scripts=true`. When installing/rebuilding native addons, use `--ignore-scripts=false`:
```bash
npm ci --ignore-scripts=false
npm rebuild @signalapp/better-sqlite3 --ignore-scripts=false
```

Node 20 required (`.nvmrc`). The native addon does not compile on Node 25+.

## Architecture

```
signal-db-cli.js          CLI entrypoint (commander commands, output formatting)
  └── lib/signal-db.js    Data layer (DB open, SQL queries, formatters)
       └── @signalapp/better-sqlite3 (SQLCipher)

decrypt-signal-key.js     Standalone utility to extract the SQLCipher key from macOS Keychain
```

**signal-db-cli.js** registers commands and handles terminal output. All database logic lives in **lib/signal-db.js** which exports pure query functions (`getUnread`, `getLastMessages`, `searchMessagesFTS`, etc.) and pure formatting functions (`formatDate`, `formatMessage`, `formatCall`, `toFTS5Query`).

The database is always opened read-only. The decryption key comes from `SIGNAL_DECRYPTION_KEY` env var (loaded via dotenv from `.env` or `~/.signal-db-cli/.env`).

## Testing

Tests cover only the pure functions (formatters, query builders) that don't require a database connection. Importing `lib/signal-db.js` loads the native SQLCipher module but doesn't open any database, so tests work without the Signal DB present.

Test file uses ESM imports (`import from`) even though the source is CJS — Vitest handles the transform.

## FTS5 Query Syntax

`toFTS5Query()` converts user-friendly syntax: spaces = OR, commas = AND, each term gets a `*` suffix for prefix matching. Example: `"ahoj svete, deadline"` becomes `"(ahoj* OR svete*) AND deadline*"`.
