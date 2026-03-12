# Signal DB CLI – Uživatelská příručka

## Úvod

Signal DB CLI je nástroj pro práci s lokální šifrovanou databází Signal Desktop. Umožňuje číst zprávy, konverzace a hovory bez nutnosti otevírat Signal aplikaci.

**Důležité:** Nástroj pracuje v režimu pouze pro čtení. Databázi nemění.

## Předpoklady

- Nainstalovaný Signal Desktop
- Node.js 24
- Dešifrovací klíč z `config.json` Signal aplikace

## Umístění databáze

Signal ukládá data v šifrovaném SQLite souboru:

- **macOS:** `~/Library/Application Support/Signal/sql/db.sqlite`
- **Windows:** `%APPDATA%\Signal\sql\db.sqlite`
- **Linux:** `~/.config/Signal/sql/db.sqlite`

## Konfigurace

Klíč pro dešifrování nastav v proměnné prostředí `SIGNAL_DECRYPTION_KEY`. Můžeš použít:

1. **Lokální `.env`** v kořeni projektu
2. **Globální konfigurace** v `~/.signal-db-cli/.env`

Formát `.env`:
```
SIGNAL_DECRYPTION_KEY=REDACTED_KEY
```

Klíč zjistíš příkazem `signal-db-cli decrypt` (macOS), nebo ho najdeš v Signal složce v souboru `config.json` (klíč `key` – podle verze Signalu).

**Poznámka:** Před použitím je třeba zavřít Signal Desktop, jinak může být databáze uzamčená.

## Přehled příkazů

### Příkazy

| Příkaz | Popis |
|--------|-------|
| `messages [query]` (alias: `msg`) | Zprávy s filtry (full-text, konverzace, nepřečtené, bez odpovědi, datum) |
| `convs [query]` | Seznam konverzací (volitelně hledat podle názvu) |
| `phone <query>` | Vyhledat telefonní číslo podle jména kontaktu |
| `calls [n]` | Historie hovorů |
| `interactive` (alias: `i`) | Interaktivní režim – hlavní menu |
| `decrypt` | Zjistit dešifrovací klíč z Signal Desktop (macOS) |
| `manual` | Tato dokumentace |

### Filtry pro `messages`

| Přepínač | Popis |
|----------|-------|
| `--conv <name>` | Filtr na konverzaci (název, telefon nebo UUID) |
| `--unread` | Jen nepřečtené příchozí zprávy |
| `--unanswered [hours]` | Bez odpovědi, starší než N hodin (default 24) |
| `--from <date>` | Od data (ISO např. 2025-01-15, nebo relativní: 5h, 3d, 10m) |
| `--to <date>` | Do data (ISO nebo relativní) |
| `--incoming` | Jen příchozí zprávy |
| `--outgoing` | Jen odchozí zprávy |

### Globální přepínače

- `-i, --interactive` – spustí interaktivní výběr (Inquirer)
- `--json` – výstup ve formátu JSON (vhodné pro skripty a jq)
- `-n, --limit <number>` – omezí počet výsledků
- `-V, --version` – zobrazí verzi

## Příklady

```bash
# Nepřečtené zprávy
signal-db-cli messages --unread

# Posledních 20 zpráv
signal-db-cli messages

# Zprávy z konverzace (podle části názvu)
signal-db-cli messages --conv "Tomas"
signal-db-cli messages --conv SMARTA -n 10

# Full-text vyhledávání v zprávách
signal-db-cli messages "deadline"

# Rozsah dat
signal-db-cli messages "deadline" --from 2025-01-01 --to 2025-02-17

# Relativní datum (posledních 5 hodin)
signal-db-cli messages --from 5h

# Jen příchozí zprávy
signal-db-cli messages --incoming

# Bez odpovědi (starší než 24h)
signal-db-cli messages --unanswered

# Bez odpovědi (starší než 48h)
signal-db-cli messages --unanswered 48

# Vyhledání konverzací
signal-db-cli convs "CI/CD"

# Seznam skupinových konverzací
signal-db-cli convs --type group

# Telefonní číslo podle jména
signal-db-cli phone "Novák"

# Historie hovorů
signal-db-cli calls 30

# Interaktivní režim
signal-db-cli interactive

# Zjistit dešifrovací klíč (macOS)
signal-db-cli decrypt

# JSON výstup pro další zpracování
signal-db-cli messages --unread --json | jq '.messages[0].body'
```

## Syntax vyhledávání

Full-text vyhledávání v příkazu `messages [query]`:

- **Mezera** = OR – zpráva obsahuje alespoň jeden term (`ahoj deadline` = ahoj NEBO deadline)
- **Čárka** = AND – zpráva musí obsahovat všechny termy (`ahoj, deadline` = ahoj A deadline)
- **Částečná shoda** – automaticky; `aho` najde „ahoj", „ahojky", `dead` najde „deadline"
- Kombinace: `ahoj deadline, meeting` = (ahoj NEBO deadline) A meeting

## Interaktivní režim

Spusť `signal-db-cli interactive` nebo `signal-db-cli i` pro hlavní menu. Z nabídky vybereš akci:

- **Nepřečtené zprávy** – zobrazí nepřečtené příchozí
- **Poslední zprávy** – zobrazí posledních 20 zpráv
- **Konverzace** – vybereš konverzaci psaním (filtruje se seznam), pak zobrazí zprávy
- **Hledat v zprávách** – zadáš text, vybereš z výsledků a zobrazí detail
- **Bez odpovědi** – zobrazí zprávy bez odpovědi
- **Historie hovorů** – zobrazí hovory

U příkazu `messages` můžeš použít `-i` pro interaktivní výběr konverzace nebo fulltextové hledání.

## MCP Server

Nástroj obsahuje MCP server (`signal-db-mcp`) pro integraci s AI nástroji. Spouští se jako:

```bash
signal-db-mcp
```

Dostupné nástroje: `get_messages`, `get_conversations`, `get_calls`, `get_message_by_id`, `get_phone`.

## Aktualizace

Nástroj pravidelně kontroluje npm registry. Pokud je dostupná nová verze, zobrazí se při spuštění hláška:

```
Update available 0.1.0 → 0.2.0
Run: npm install -g signal-db-cli
```

Pro vypnutí kontroly nastav `NO_UPDATE_NOTIFIER=1`.

## Troubleshooting

### Chybí SIGNAL_DECRYPTION_KEY
Zkontroluj, že máš v `.env` nebo v prostředí nastavenou proměnnou `SIGNAL_DECRYPTION_KEY` s platným hex klíčem. Můžeš ho zjistit příkazem `signal-db-cli decrypt`.

### Databáze je uzamčená
Zavři Signal Desktop před použitím nástroje. Signal drží exkluzivní zámek na databázi.

### SQLITE_BUSY
Databáze je použita jiným procesem. Zavři Signal Desktop a zkus znovu.
