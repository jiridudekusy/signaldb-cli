# Signal DB CLI – User Manual

## Introduction

Signal DB CLI is a tool for working with the local encrypted Signal Desktop database. It allows you to read messages, conversations, and calls without opening the Signal app.

**Important:** The tool operates in read-only mode. It does not modify the database.

## Prerequisites

- Signal Desktop installed
- Node.js 24

## Database Location

Signal stores data in an encrypted SQLite file:

- **macOS:** `~/Library/Application Support/Signal/sql/db.sqlite`
- **Windows:** `%APPDATA%\Signal\sql\db.sqlite`
- **Linux:** `~/.config/Signal/sql/db.sqlite`

## Configuration

Run `signal-db-cli decrypt` to extract the decryption key and save it automatically to `~/.signal-db-cli/.env`. This works on macOS (Keychain), Linux (GNOME Keyring / KWallet), and Windows (DPAPI).

The key is stored in the `SIGNAL_DECRYPTION_KEY` environment variable. The tool loads it from:

1. **Local `.env`** in the current directory
2. **Global config** in `~/.signal-db-cli/.env`

**Note:** Close Signal Desktop before use, otherwise the database may be locked.

## Command Overview

### Commands

| Command | Description |
|---------|-------------|
| `messages [query]` (alias: `msg`) | Messages with filters (full-text, conversation, unread, unanswered, date) |
| `convs [query]` | List conversations (optionally search by name) |
| `phone <query>` | Look up phone number by contact name |
| `calls [n]` | Call history |
| `interactive` (alias: `i`) | Interactive mode – main menu |
| `decrypt` | Extract decryption key from Signal Desktop and save to ~/.signal-db-cli/.env |
| `manual` | This documentation |

### Filters for `messages`

| Flag | Description |
|------|-------------|
| `--conv <name>` | Conversation filter – searches by partial name (queries all matches), `=Exact name` for a single conversation, or UUID |
| `--unread` | Only unread incoming messages |
| `--unanswered [hours]` | Unanswered, older than N hours (default 24) |
| `--from <date>` | From date (ISO e.g. 2025-01-15, or relative: 5h, 3d, 10m) |
| `--to <date>` | To date (ISO or relative) |
| `--incoming` | Only incoming messages |
| `--outgoing` | Only outgoing messages |

### Global Flags

- `-i, --interactive` – launch interactive mode (Inquirer)
- `--json` – output as JSON (useful for scripts and jq)
- `-n, --limit <number>` – limit number of results
- `-V, --version` – show version

## Examples

```bash
# Unread messages
signal-db-cli messages --unread

# Last 20 messages
signal-db-cli messages

# Messages from a conversation (by partial name – queries all matches)
signal-db-cli messages --conv "Tomas"
signal-db-cli messages --conv SMARTA -n 10

# Exact conversation name match (= prefix)
signal-db-cli messages --conv "=USY HoT"

# Conversation by UUID
signal-db-cli messages --conv "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

# Full-text search in messages
signal-db-cli messages "deadline"

# Date range
signal-db-cli messages "deadline" --from 2025-01-01 --to 2025-02-17

# Relative date (last 5 hours)
signal-db-cli messages --from 5h

# Only incoming messages
signal-db-cli messages --incoming

# Unanswered (older than 24h)
signal-db-cli messages --unanswered

# Unanswered (older than 48h)
signal-db-cli messages --unanswered 48

# Search conversations
signal-db-cli convs "CI/CD"

# List group conversations
signal-db-cli convs --type group

# Phone number by name
signal-db-cli phone "Smith"

# Call history
signal-db-cli calls 30

# Interactive mode
signal-db-cli interactive

# Extract decryption key and save to ~/.signal-db-cli/.env
signal-db-cli decrypt

# JSON output for further processing
signal-db-cli messages --unread --json | jq '.messages[0].body'
```

## Search Syntax

Full-text search in the `messages [query]` command:

- **Space** = OR – message contains at least one term (`hello deadline` = hello OR deadline)
- **Comma** = AND – message must contain all terms (`hello, deadline` = hello AND deadline)
- **Prefix matching** – automatic; `hel` finds "hello", "helpful", `dead` finds "deadline"
- Combined: `hello deadline, meeting` = (hello OR deadline) AND meeting

## Conversation Filter (`--conv`)

The `--conv` flag supports three modes:

1. **Partial name search** (`--conv "Tomas"`) — finds all conversations whose name contains the given text, and queries messages across all matches. If there's only one match, the conversation name is displayed.
2. **Exact match** (`--conv "=USY HoT"`) — the `=` prefix forces exact name matching. Returns messages from a single conversation only.
3. **UUID** (`--conv "a1b2c3d4-e5f6-7890-abcd-ef1234567890"`) — direct conversation ID.

If the search finds no conversation, the command exits with an error.

## Interactive Mode

Run `signal-db-cli interactive` or `signal-db-cli i` for the main menu. Choose an action:

- **Unread messages** – shows unread incoming messages
- **Recent messages** – shows the last 20 messages
- **Conversations** – select a conversation by typing (list is filtered), then shows messages
- **Search messages** – enter text, select from results, and view detail
- **Unanswered** – shows unanswered messages
- **Call history** – shows calls

With the `messages` command, you can use `-i` for interactive conversation selection or full-text search.

## MCP Server

The tool includes an MCP server (`signal-db-mcp`) for integration with AI tools. Run it as:

```bash
npx -y --ignore-scripts=false -p signal-db-cli signal-db-mcp
```

Available tools: `get_messages`, `get_conversations`, `get_calls`, `get_message_by_id`, `get_phone`.

## Updates

The tool periodically checks the npm registry. If a new version is available, a message is shown at startup:

```
Update available 0.1.0 → 0.2.0
Run: npm install -g signal-db-cli
```

To disable the check, set `NO_UPDATE_NOTIFIER=1`.

## Troubleshooting

### Missing SIGNAL_DECRYPTION_KEY
Run `signal-db-cli decrypt` to extract and save the key automatically. Alternatively, set the `SIGNAL_DECRYPTION_KEY` environment variable in `.env` or `~/.signal-db-cli/.env` with a valid hex key.

### Database is locked
Close Signal Desktop before using the tool. Signal holds an exclusive lock on the database.

