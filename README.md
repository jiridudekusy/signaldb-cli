# Signal DB CLI & MCP Server

Read-only access to your local Signal Desktop database — from the terminal or through AI assistants via MCP.

> **Read-only.** The tool never modifies your Signal database.

## Prerequisites

- **Signal Desktop** installed and set up
- **Node.js 24** (see `.nvmrc`)
- **macOS / Linux / Windows**

## Quick Start

**1. Install** (needed for the CLI and the `decrypt` command):

```bash
npm install -g signal-db-cli --ignore-scripts=false
```

**2. Extract the decryption key** (close Signal Desktop first):

```bash
signal-db-cli decrypt
```

This extracts the key from your system keychain / keyring and saves it to `~/.signal-db-cli/.env`. Works on **macOS** (Keychain), **Linux** (GNOME Keyring / KWallet), and **Windows** (DPAPI).

**3. Set up the MCP server** (see below) or use the CLI directly.

> The `--ignore-scripts=false` flag is required to compile the native SQLCipher addon.

---

## Part 1: MCP Server (AI Assistants)

The MCP server lets AI assistants browse your Signal messages, conversations, and calls using natural language.

### Available Tools

| Tool | Description |
|------|-------------|
| `get_messages` | Search and filter messages — full-text search, conversation filter, unread/unanswered, date ranges, direction |
| `get_conversations` | List or search conversations by name, phone, or ID |
| `get_calls` | Recent call history |
| `get_message_by_id` | Retrieve a single message by ID (full body) |
| `get_phone` | Look up phone numbers by contact name |

### Setup

> Run `signal-db-cli decrypt` first (see Quick Start above). The MCP server loads the key automatically from `~/.signal-db-cli/.env`.

#### Claude Code

```bash
claude mcp add signal-db -- npx -y --ignore-scripts=false -p signal-db-cli signal-db-mcp
```

#### Claude Desktop

Open the config file:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add the `signal-db` server (merge into existing `mcpServers` if needed):

```json
{
  "mcpServers": {
    "signal-db": {
      "command": "npx",
      "args": ["-y", "--ignore-scripts=false", "-p", "signal-db-cli", "signal-db-mcp"]
    }
  }
}
```

Then restart Claude Desktop.

#### Cursor

[<img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Install in Cursor" height="32">](https://cursor.com/en/install-mcp?name=signal-db&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0taWdub3JlLXNjcmlwdHM9ZmFsc2UiLCItcCIsInNpZ25hbC1kYi1jbGkiLCJzaWduYWwtZGItbWNwIl19)

Or manually — create/edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "signal-db": {
      "command": "npx",
      "args": ["-y", "--ignore-scripts=false", "-p", "signal-db-cli", "signal-db-mcp"]
    }
  }
}
```

Then restart Cursor or reload the MCP servers (Cmd+Shift+P > "MCP: Reload").

### Example Prompts

Once the MCP server is connected, you can ask your AI assistant things like:

**Catch up on conversations:**
> What was I last discussing with John Doe?

> Show me all messages from the "Project Alpha" group in the last 3 days.

**Track what needs your attention:**
> Which messages are waiting for my reply?

> What unread messages do I have?

**Look up contacts:**
> What is John Doe's phone number?

**Summarize group activity:**
> Summarize the activity of the "Support Team" group for February 2026. What were the main topics, how were they resolved, who asked questions and who helped? Give me an executive summary.

**Cross-conversation research:**
> Find all messages mentioning "deadline" in the last week across all conversations.

> What did the AI User Group discuss recently? What are the key takeaways?

---

## Part 2: CLI

### Commands

| Command | Description |
|---------|-------------|
| `messages [query]` (alias: `msg`) | Messages with filters (full-text, conversation, unread, unanswered, date) |
| `convs [query]` | List conversations (optionally search by name) |
| `phone <query>` | Look up phone number by contact name |
| `calls [n]` | Call history |
| `interactive` (alias: `i`) | Interactive mode — main menu |
| `decrypt` | Extract decryption key and save to `~/.signal-db-cli/.env` |
| `manual` | Extended documentation |

### Message Filters

| Flag | Description |
|------|-------------|
| `--conv <name>` | Conversation filter — partial name (searches all matches), `=Exact Name` for single match, or UUID |
| `--unread` | Only unread incoming messages |
| `--unanswered [hours]` | Unanswered, older than N hours (default 24) |
| `--from <date>` | From date (ISO e.g. `2025-01-15`, or relative: `5h`, `3d`, `10m`) |
| `--to <date>` | To date (ISO or relative) |
| `--incoming` | Only incoming messages |
| `--outgoing` | Only outgoing messages |

### Global Flags

| Flag | Description |
|------|-------------|
| `-i, --interactive` | Interactive mode (Inquirer) |
| `--json` | Output as JSON |
| `-n, --limit <N>` | Limit number of results |
| `-V, --version` | Show version |

### Examples

```bash
# Unread messages
signal-db-cli messages --unread

# Last 20 messages
signal-db-cli messages

# Messages from a conversation (partial name — searches all matches)
signal-db-cli messages --conv "Tomas"

# Exact conversation name match (= prefix)
signal-db-cli messages --conv "=Project Alpha"

# Full-text search
signal-db-cli messages "deadline"

# Date range
signal-db-cli messages --from 2025-01-01 --to 2025-02-17

# Relative date (last 5 hours)
signal-db-cli messages --from 5h

# Unanswered messages (older than 48h)
signal-db-cli messages --unanswered 48

# List group conversations
signal-db-cli convs --type group

# Phone number lookup
signal-db-cli phone "Smith"

# Call history
signal-db-cli calls 30

# Interactive mode
signal-db-cli interactive

# JSON output for scripting
signal-db-cli messages --unread --json | jq '.messages[0].body'
```

### Search Syntax

Full-text search in `messages [query]`:

- **Space** = OR — `hello deadline` finds messages with "hello" OR "deadline"
- **Comma** = AND — `hello, deadline` finds messages with both
- **Prefix matching** — automatic: `hel` matches "hello", "help"
- Combined: `hello deadline, meeting` = (hello OR deadline) AND meeting

### Conversation Filter (`--conv`)

Three modes:

1. **Partial name** (`--conv "Tomas"`) — finds all matching conversations, queries messages across all of them
2. **Exact match** (`--conv "=Project Alpha"`) — `=` prefix forces exact name match, returns a single conversation
3. **UUID** (`--conv "a1b2c3d4-e5f6-..."`) — direct conversation ID

---

## License

MIT
