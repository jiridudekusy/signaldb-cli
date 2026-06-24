# Changelog

## 1.1.0 (2026-06-24)

### New Features

- **Group chat sender display** — group messages now show who sent each message (`Contact Name:` for incoming, `Me:` for outgoing). Private 1:1 conversations are unchanged. Works in CLI output, `--json`, context search (`-A`/`-B`/`-C`), rotting messages, and MCP (via `conversationType`/`senderName` fields).

### Maintenance

- Updated dependencies (`@signalapp/sqlcipher`, MCP SDK, Commander 15, Zod 4, Vitest 4, ESLint 10, and others).

## 1.0.0 (2026-03-13)

### New Features

- **Grep-style context search (`-A`/`-B`/`-C`)** — show surrounding messages around each search match, just like `grep`. Use `-C 3` for 3 messages before and after, or `-B 2 -A 1` for asymmetric context. Overlapping windows are merged automatically. Works with `--json` and MCP.
- **System locale date formatting** — dates now use the system locale instead of hardcoded `en-US`.

### Breaking Changes

- **Migrated from `@signalapp/better-sqlite3` to `@signalapp/sqlcipher`** — the native addon has changed. Run `npm ci --ignore-scripts=false` or `npm rebuild @signalapp/sqlcipher --ignore-scripts=false` after upgrading.

## 0.2.0 (2026-02-27)

- MCP server setup configs updated to use `npx`
- Added `publishConfig` for npm publishing
- Cross-platform `decrypt` command with auto-save to env file
- All UI text and docs translated to English

## 0.1.0

- Initial release
- CLI commands: `messages`, `convs`, `phone`, `calls`, `interactive`, `decrypt`, `manual`
- MCP server with stdio transport
- Full-text search with FTS5 (spaces=OR, commas=AND, prefix matching)
- Conversation filter with fuzzy, exact, and UUID modes
- Unread, unanswered, date range, and direction filters
- JSON output mode
- Cross-platform decryption key extraction (macOS, Linux, Windows)
