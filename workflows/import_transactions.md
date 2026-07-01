# Import Transactions Workflow

## Goal
Log one conversational entry, import a CSV, then re-import the same CSV and confirm duplicates
are skipped and reported (not silently dropped or silently re-posted).

## Checklist

### 1. Start the pi agent
```bash
npx pi
# or
npm run pi
# or
bash scripts/run_agent.sh
```

Accept the trust prompt for `.pi/extensions/bank_sync` if this is the first run with the
extension enabled.

### 2. Make sure a source account exists
```
create account Assets:Checking (type: asset)
```
(Skip if already created from `workflows/setup_ledger.md`.)

### 3. Log one conversational entry
```
log a transaction: $42 at Trader Joe's yesterday, from checking
```
The agent should restate the parsed date/amount/payee/account and confirm with you before
calling `log_transaction`. Expect a result like:
```
Logged transaction 1 on 2024-06-29: Trader Joe's
```

### 4. Put a CSV in the inbox
Place a bank/card export at `data/inbox/<bank>_<month>.csv`, e.g. `data/inbox/chase_march.csv`.
A minimal well-formed example (single signed `amount` column):
```csv
Date,Description,Amount
2024-06-01,Trader Joes 123 Seattle,-55.20
2024-06-03,Paycheck,1500.00
```

### 5. Import the CSV
```
import the CSV at data/inbox/chase_march.csv into Assets:Checking
```
Expect a summary like:
```
Imported 2 row(s), skipped 0 likely duplicate(s), 0 error(s) out of 2 row(s).
```

### 6. Re-import the same CSV
```
import the CSV at data/inbox/chase_march.csv into Assets:Checking
```
Expect every row to be reported as a skipped duplicate, and nothing new posted:
```
Imported 0 row(s), skipped 2 likely duplicate(s), 0 error(s) out of 2 row(s).
```
Check `skipped_duplicates` in the tool result — each entry names the row and the matched
transaction id, not just a silent drop.

### 7. Verify with list_transactions
```
list transactions for Assets:Checking
```
Should show exactly 3 transactions total (1 logged + 2 imported), not 5 — the re-import posted
nothing new.

## Next Steps
- Review `AGENTS.md` hard rule 5 (duplicates must be surfaced, never silently skipped or posted).
- Review `BRAIN.md` for the dedup tolerance (date window, amount, fuzzy description) and the
  Uncategorized-account convention.
- Run `npm test` to verify the ingestion core (`test/ingestion.test.ts`).
