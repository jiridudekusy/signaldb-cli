# Signal DB CLI – Uživatelská příručka

## Úvod

Signal DB CLI je nástroj pro práci s lokální šifrovanou databází Signal Desktop. Umožňuje číst zprávy, konverzace a hovory bez nutnosti otevírat Signal aplikaci.

**Důležité:** Nástroj pracuje v režimu pouze pro čtení. Databázi nemění.

## Předpoklady

- Nainstalovaný Signal Desktop
- Node.js 18+
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

Klíč najdeš v Signal složce v souboru `config.json` (klíč `key` nebo `encryptedKey` – podle verze Signalu).

**Poznámka:** Před použitím je třeba zavřít Signal Desktop, jinak může být databáze uzamčená.

## Přehled příkazů

### Základní příkazy

| Příkaz | Popis |
|--------|-------|
| `unread [n]` | Nepřečtené příchozí zprávy |
| `last [n]` | Posledních n zpráv ze všech konverzací |
| `conv [query] [n]` | Zprávy z konverzace (query = název nebo ID) |
| `search <query>` | Vyhledat konverzace podle názvu |
| `search-msg <query>` | Full-text vyhledávání v těle zpráv |
| `convs` | Seznam konverzací |
| `calls [n]` | Historie hovorů |
| `rotting [hodiny]` | Hnijící zprávy (bez odpovědi) |
| `interactive`, `i` | Interaktivní režim |
| `manual` | Tato dokumentace |
| `help [příkaz]` | Nápověda k příkazu |

### Globální přepínače

- `-i, --interactive` – spustí interaktivní výběr (Inquirer)
- `--json` – výstup ve formátu JSON (vhodné pro skripty a jq)
- `-n, --limit <number>` – omezí počet výsledků
- `-V, --version` – zobrazí verzi

## Příklady

```bash
# Nepřečtené zprávy (posledních 50)
signal-db-cli unread

# Posledních 20 zpráv
signal-db-cli last 20

# Zprávy z konverzace (podle části názvu)
signal-db-cli conv SMARTA 10
signal-db-cli conv "Tomas Horáček" 5

# Interaktivní výběr konverzace
signal-db-cli conv -i

# Vyhledání konverzací
signal-db-cli search CI/CD

# Full-text vyhledávání v zprávách
signal-db-cli search-msg "deadline"
# Rozsah dat: --from, --to (ISO např. 2025-01-15)
signal-db-cli search-msg "deadline" --from 2025-01-01 --to 2025-02-17
# Syntax: mezera = OR, čárka = AND
# "ahoj deadline" = ahoj NEBO deadline
# "ahoj, deadline" = ahoj A deadline

# Seznam konverzací
signal-db-cli convs
signal-db-cli convs --type group

# Historie hovorů
signal-db-cli calls 30

# Hnijící zprávy (starší než 24h bez odpovědi)
signal-db-cli rotting 24

# JSON výstup pro další zpracování
signal-db-cli unread --json | jq '.messages[0].body'
```

## Interaktivní režim

Spusť `signal-db-cli interactive` nebo `signal-db-cli i` pro hlavní menu. Z nabídky vybereš akci:

- **Nepřečtené zprávy** – zobrazí nepřečtené
- **Poslední zprávy** – zobrazí poslední
- **Konverzace** – vybereš konverzaci psaním (filtruje se seznam), pak zobrazí zprávy
- **Hledat v zprávách** – zadáš text, vybereš z výsledků a zobrazí detail
- **Historie hovorů** – zobrazí hovory
- **Hnijící zprávy** – zobrazí zprávy bez odpovědi

U příkazů `conv` a `search-msg` můžeš použít `-i` pro interaktivní výběr přímo v rámci příkazu.

## Aktualizace

Nástroj pravidelně kontroluje npm registry. Pokud je dostupná nová verze, zobrazí se při spuštění hláška:

```
Update available 0.1.0 → 0.2.0
Run: npm install -g signal-db-cli
```

Pro vypnutí kontroly nastav `NO_UPDATE_NOTIFIER=1`.

## Troubleshooting

### Chybí SIGNAL_DECRYPTION_KEY
Zkontroluj, že máš v `.env` nebo v prostředí nastavenou proměnnou `SIGNAL_DECRYPTION_KEY` s platným klíčem z Signal `config.json`.

### Databáze je uzamčená
Zavři Signal Desktop před použitím nástroje. Signal drží exkluzivní zámek na databázi.

### SQLITE_BUSY
Databáze je použita jiným procesem. Zavři Signal Desktop a zkus znovu.

### Syntax vyhledávání (search-msg)
- **--from, --to** – rozsah dat (ISO formát, např. `2025-01-15`)
- **Mezera** = OR – zpráva obsahuje alespoň jeden term (`ahoj deadline` = ahoj NEBO deadline)
- **Čárka** = AND – zpráva musí obsahovat všechny termy (`ahoj, deadline` = ahoj A deadline)
- **Částečná shoda** – automaticky; `aho` najde „ahoj", „ahojky", `dead` najde „deadline"
- Kombinace: `ahoj deadline, meeting` = (ahoj NEBO deadline) A meeting

### Žádné výsledky u search-msg
FTS (full-text search) vyžaduje, aby zprávy obsahovaly hledaný text. Zkus jiný výraz nebo zkrácenou podobu.
