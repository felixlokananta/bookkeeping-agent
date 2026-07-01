# Setup Ledger Workflow

## Goal
Initialize a fresh SQLite ledger with the default chart of accounts and verify it is ready for posting.

## Checklist

### 1. Install dependencies
```bash
npm install
```

### 2. Start the pi agent
```bash
npx pi
# or
npm run pi
# or
bash scripts/run_agent.sh
```

The first run will show a trust prompt for the `.pi/extensions` directory. Accept to enable the bookkeeping extension.

### 3. Initialize the database (if needed)
The database is auto-initialized on the first run. Verify the default chart exists:
```
list all accounts
```
You should see five roots: Assets, Liabilities, Equity, Income, Expenses.

### 4. Create sub-accounts
Create checking and capital accounts for the first entry:
```
create account Assets:Checking (type: asset)
create account Equity:Owner (type: equity)
```

### 5. Post the first balanced entry
An owner's investment:
```
post a $100 owner investment:
- Debit Assets:Checking $100
- Credit Equity:Owner $100
dated today, balanced
```

Or via structured input:
- Date: today's date (YYYY-MM-DD)
- Splits:
  - Account: `Assets:Checking`, Amount: +100
  - Account: `Equity:Owner`, Amount: -100
- Description: "Initial owner investment"

### 6. Verify the balance
Query the checking account:
```
what is the balance of Assets:Checking?
```
Should show +$100 (natural balance).

## Next Steps
- Review `AGENTS.md` for hard rules.
- Review `BRAIN.md` for chart structure.
- Run `npm test` to verify the ledger core.
