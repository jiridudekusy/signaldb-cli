# Manual Testing — Signal DB CLI

Test plan for verifying CLI and MCP functionality against a real Signal Desktop database.

## Prerequisites

- Signal Desktop installed with data
- Decryption key saved: `signal-db-cli decrypt`

---

## 1. Basic connectivity & conversations

```bash
./signal-db-cli.js convs --limit 5
```
**Expected:** 5 conversations with names, types `[group]`/`[private]`, and dates. Header: `--- Conversations (5) ---`

```bash
./signal-db-cli.js convs --type group --limit 3
```
**Expected:** Only `[group]` conversations.

```bash
./signal-db-cli.js convs --type private --limit 3
```
**Expected:** Only `[private]` conversations.

```bash
./signal-db-cli.js convs "nonexistent_contact_xyz_12345"
```
**Expected:** `No conversation matches "nonexistent_contact_xyz_12345"`

---

## 2. Messages — basic

```bash
./signal-db-cli.js messages --limit 5
```
**Expected:** 5 recent messages with timestamps, conversation names, direction arrows (`▶` incoming / `◀` outgoing), and body text. Header shows total count.

```bash
./signal-db-cli.js messages --limit 1 --json
```
**Expected:** Valid JSON: `{ "messages": [...], "total": <number>, "conversationName": null }`. `total` should be much larger than 1.

---

## 3. Messages — conversation filter

```bash
./signal-db-cli.js messages --conv "AI" --limit 3
```
**Expected:** Messages from conversations matching "AI". If multiple match, header: `AI (<N> conversations)`.

```bash
./signal-db-cli.js messages --conv "=<exact group name>" --limit 3
```
**Expected:** Messages from exactly that conversation. Header shows the exact name. Replace `<exact group name>` with a known conversation name.

```bash
./signal-db-cli.js messages --conv "nonexistent_xyz_12345"
```
**Expected:** Error: `Conversation not found: "nonexistent_xyz_12345"`

---

## 4. Messages — direction filters

```bash
./signal-db-cli.js messages --incoming --limit 5
```
**Expected:** All messages show `▶` (incoming).

```bash
./signal-db-cli.js messages --outgoing --limit 5
```
**Expected:** All messages show `◀` (outgoing).

```bash
./signal-db-cli.js messages --incoming --outgoing
```
**Expected:** Error: `Cannot combine --incoming and --outgoing`

---

## 5. Messages — unread

```bash
./signal-db-cli.js messages --unread --limit 5
```
**Expected:** Only incoming (`▶`) messages. May return 0 if all read.

```bash
./signal-db-cli.js messages --unread --outgoing
```
**Expected:** Error: `Cannot combine --unread and --outgoing (unread messages are always incoming)`

---

## 6. Messages — unanswered

```bash
./signal-db-cli.js messages --unanswered --limit 5
```
**Expected:** Incoming messages without reply, older than 24h. Shows per-conversation dedup with message count, e.g. `(25h) Alice (9 messages): ...`

```bash
./signal-db-cli.js messages --unanswered 1 --limit 5
```
**Expected:** Same but 1-hour threshold — likely more results than the 24h default.

---

## 7. Messages — date range

```bash
./signal-db-cli.js messages --from 1h --limit 5
```
**Expected:** Only messages from the last hour.

```bash
./signal-db-cli.js messages --from 2026-03-12 --to 2026-03-12 --limit 5
```
**Expected:** Only messages from March 12th. Adjust date to a day with known activity.

```bash
./signal-db-cli.js messages --from "invalid_date"
```
**Expected:** Error: `Invalid date format: "invalid_date" (allowed: ISO date, relative offset like 10m/5h/8d)`

---

## 8. Messages — full-text search (FTS)

```bash
./signal-db-cli.js messages "ahoj" --limit 5
```
**Expected:** Messages containing "ahoj" (prefix match). Should return results.

```bash
./signal-db-cli.js messages "xyznonexistent123" --limit 5
```
**Expected:** `--- "xyznonexistent123" (0/0) ---` — zero results, no error.

---

## 9. Messages — combined filters

```bash
./signal-db-cli.js messages --conv "AI" --from 7d --incoming --limit 5
```
**Expected:** Only incoming messages from AI-matching conversations in the last 7 days. All show `▶`.

---

## 10. Phone lookup

```bash
./signal-db-cli.js phone "Max"
```
**Expected:** Contact(s) matching "Max" with phone numbers. Replace with a known contact.

```bash
./signal-db-cli.js phone "nonexistent_xyz_12345"
```
**Expected:** `No contact with phone number matches "nonexistent_xyz_12345"`

---

## 11. Call history

```bash
./signal-db-cli.js calls 5
```
**Expected:** 5 calls with direction (`📞↓`/`📞↑`), status, conversation name, and timestamps.

---

## 12. JSON output

```bash
./signal-db-cli.js convs --limit 2 --json
```
**Expected:** Valid JSON. Each item has `id`, `name`, `type`, `e164`, `active_at`.

```bash
./signal-db-cli.js calls 2 --json
```
**Expected:** Valid JSON with call records including `callId`, `direction`, `status`, `timestamp`, `conversationName`.

---

## 13. Decrypt command

```bash
cat ~/.signal-db-cli/.env
```
**Expected:** Contains `SIGNAL_DECRYPTION_KEY=<hex string>`.

---

## 14. Manual page

```bash
./signal-db-cli.js manual | head -5
```
**Expected:** Starts with `# Signal DB CLI – User Manual`.

---

## 15. MCP server smoke test

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node signal-db-mcp.js 2>/dev/null | head -1
```
**Expected:** JSON-RPC response containing `"serverInfo":{"name":"signal-db","version":"..."}`.

---

## 16. Messages — context (grep-style -A/-B/-C)

```bash
./signal-db-cli.js messages "ahoj" -C 2 --limit 3
```
**Expected:** Groups of messages around each match. Matches prefixed with `>`, context with space. Groups separated by `--`. Chronological order within each group.

```bash
./signal-db-cli.js messages "ahoj" -B 3 --limit 3
```
**Expected:** 3 messages before each match shown, no messages after.

```bash
./signal-db-cli.js messages "ahoj" -A 1 -B 1 --limit 3
```
**Expected:** 1 message before and 1 after each match.

```bash
./signal-db-cli.js messages "ahoj" -C 2 --conv "AI" --limit 3
```
**Expected:** Context shown only within the matching conversation(s).

```bash
./signal-db-cli.js messages "ahoj" -C 2 --limit 3 --json
```
**Expected:** Valid JSON with `{ "groups": [...], "total": <number> }`. Each group has `messages` array with `isMatch` boolean on each message.

```bash
./signal-db-cli.js messages -C 2
```
**Expected:** Error: `Context options (-A/-B/-C) require a search query`

---

## 17. Error resilience

```bash
SIGNAL_DECRYPTION_KEY=badkey ./signal-db-cli.js convs --limit 1
```
**Expected:** Error: `Invalid SIGNAL_DECRYPTION_KEY: must be a non-empty hex string` (graceful, no crash/segfault).

```bash
SIGNAL_DECRYPTION_KEY= ./signal-db-cli.js convs --limit 1
```
**Expected:** Error: `Missing SIGNAL_DECRYPTION_KEY in .env`

