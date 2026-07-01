# Bookkeeping Agent

A SQLite-backed double-entry ledger with a natural language interface via the `pi` coding agent.

## Overview

This project provides a complete accounting system with:
- Double-entry ledger enforcing balanced transactions (debits == credits)
- Chart of accounts with nested sub-account support
- Automatic approval threshold for high-value transactions
- Append-only transaction history (no editing/deleting in v1)
- Natural language interface through the `pi` agent

## Prerequisites

- **Node.js 24+** (required for `node:sqlite` support)
- **npm** (for dependency management)

**Important:** Do NOT install `pi` globally. This project uses a repo-local copy of `pi` that is auto-discovered from `.pi/extensions/`.

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Start the Agent

Run the agent via `npx pi`:

```bash
npx pi
```

Or use the convenience scripts:

```bash
npm run pi          # alias for npx pi
npm run agent       # bash scripts/run_agent.sh
```

**First run:** You'll see a trust prompt asking to enable the `.pi/extensions/bookkeeping` extension. Accept to proceed. The database will be auto-initialized with the default chart of accounts.

### Core Tools

The agent has five tools for ledger operations:

#### `list_accounts`
Display the chart of accounts with types and normal balances.

**Example prompt:**
```
list all accounts
```

**Sample output:**
```
Chart of Accounts:
Assets                   | type: asset      | normal: debit
Assets:Checking          | type: asset      | normal: debit
Liabilities              | type: liability  | normal: credit
Equity                   | type: equity     | normal: credit
Equity:Owner             | type: equity     | normal: credit
Expenses                 | type: expense    | normal: debit
Expenses:Food            | type: expense    | normal: debit
Income                   | type: income     | normal: credit
```

#### `create_account`
Create a new account or sub-account.

**Example prompts:**
```
create account Assets:Checking (type: asset)
create account Expenses:Food:Groceries
create account Income:Salary
```

**Behavior:**
- Intermediate parents are auto-created if missing
- Type is inherited from the root if not specified
- Duplicate names are rejected

#### `post_transaction`
Post a balanced journal entry to the ledger.

**Example prompt:**
```
post a transaction:
- date: 2024-01-01
- description: Initial owner investment
- debit Assets:Checking $100
- credit Equity:Owner $100
```

**Example prompt (JSON form):**
```
post the following transaction:
- date: 2024-06-30
- description: Grocery expense
- splits:
  - account: Expenses:Food, amount: +50 (debit)
  - account: Assets:Checking, amount: -50 (credit)
```

**Important rules:**
- At least 2 splits required
- Amounts must sum to zero (balanced)
- Total debits must not exceed the auto-post limit ($500 default) without approval
- Unbalanced or unknown-account posts are rejected and logged to `memory/anomaly_log.json`

**Above-threshold behavior:**
If a transaction exceeds the limit without approval:
```
Transaction exceeds auto-post limit of $500. Set approved: true to override.
```

Re-post with approval:
```
post the same transaction with approved: true
```

#### `get_balance`
Query the balance of an account.

**Example prompts:**
```
what is the balance of Assets:Checking?
show the balance of Expenses:Food as of 2024-06-30
```

**Output:** Natural balance (always shown positive when the account is "full").
- Debit-normal accounts (Assets, Expenses): positive = debits exceed credits
- Credit-normal accounts (Liabilities, Equity, Income): positive = credits exceed debits

#### `list_transactions`
List transactions with optional filters.

**Example prompts:**
```
list all transactions
show transactions for Assets:Checking in June 2024
list the last 20 transactions dated after 2024-01-01
```

## Smoke Test

Try this sequence in a fresh session:

```
1. list all accounts
   (Should show 5 roots: Assets, Liabilities, Equity, Income, Expenses)

2. create account Assets:Checking (type: asset)

3. create account Equity:Owner (type: equity)

4. post a transaction:
   - date: 2024-01-01
   - description: Initial owner investment of $100
   - splits:
     - account: Assets:Checking, amount: +100
     - account: Equity:Owner, amount: -100

5. what is the balance of Assets:Checking?
   (Should show: Assets:Checking: $100.00)

6. what is the balance of Equity:Owner?
   (Should show: Equity:Owner: $100.00)
```

Expected: Both accounts show $100 positive balance (natural balance).

## Threshold and Approval

### Default Limit

The auto-post limit is $500 (set in `config/policies.yaml`). Transactions above this limit are blocked:

**Example: Blocked transaction**

```
post a transaction:
- date: 2024-06-30
- description: Large office equipment purchase
- splits:
  - account: Assets:Equipment, amount: +5000
  - account: Assets:Checking, amount: -5000
```

**Result:**
```
Transaction exceeds auto-post limit of $500. Set approved: true to override.
```

Check the anomaly log:
```bash
cat memory/anomaly_log.json
```

You'll see an entry:
```json
{
  "ts": "2026-07-01T...",
  "kind": "above_threshold",
  "detail": "Transaction blocked: total debits 5000 exceed auto-post limit 500",
  "magnitudeMinor": 500000,
  "limitMinor": 50000
}
```

**Re-post with approval:**

```
post the same transaction with approved: true
```

**Result:** Transaction is posted successfully.

### Configuration

- **Config file:** `config/policies.yaml` (the source of truth for the threshold)
- **Env override:** `BOOKKEEPING_AUTOPOST_LIMIT` (in major units, e.g., "250" for $250)

## Double-Entry Principle

Every transaction must have at least 2 splits that sum to zero. Example of invalid input:

```
post a transaction:
- date: 2024-06-30
- splits:
  - account: Assets:Checking, amount: +100
  - account: Equity:Owner, amount: -50
```

**Result:**
```
Transaction is imbalanced: sum of amounts is 50 (not zero)
```

The transaction is rejected, nothing is written, and the anomaly is logged.

## Unit Tests

Run the comprehensive test suite:

```bash
npm test
```

**Output:** 33 tests covering:
- Ledger initialization and seed chart
- Account creation and hierarchy
- Transaction posting and validation
- Balance queries and filtering
- Auto-post threshold gate
- Money conversion helpers
- Policy loading and anomaly logging

All tests use an in-memory database (`:memory:`) for isolation and speed.

## Project Structure

```
bookkeeping-agent/
├── AGENTS.md                              # Agent identity, tone, hard rules
├── BRAIN.md                               # Domain knowledge (chart, types, currency)
├── README.md                              # This file
├── package.json                           # Root project; pi and yaml dependencies
├── package-lock.json                      # Locked dependency versions
├── .gitignore                             # DB, node_modules, session logs
│
├── config/
│   ├── settings.yaml                      # Human-facing project settings
│   └── policies.yaml                      # Auto-post threshold (single source of truth)
│
├── workflows/
│   └── setup_ledger.md                    # Seed workflow: init DB, first entry
│
├── memory/
│   ├── anomaly_log.json                   # Append-only log of blocked/flagged posts
│   ├── vendor_rules.json                  # Placeholder for issue #4
│   └── session_logs/                      # Future session transcripts
│
├── data/
│   ├── bookkeeping.db                     # SQLite ledger (git-ignored)
│   ├── inbox/                             # Raw statements/receipts (future)
│   ├── processed/                         # Processed statements (future)
│   └── exports/                           # Reports/exports (future)
│
├── scripts/
│   └── run_agent.sh                       # Wrapper to run repo-local pi
│
├── .pi/
│   ├── settings.json                      # Repo-local pi configuration
│   └── extensions/
│       ├── bookkeeping/                   # Issue #1: ledger core + tools
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter
│       │   ├── ledger.ts                  # Double-entry core (node:sqlite)
│       │   ├── schema.ts                  # DDL + default chart + types
│       │   ├── money.ts                   # Major<->minor unit helpers
│       │   └── policy.ts                  # Threshold + anomaly logging
│       ├── bank_sync/EXTENSION.md         # Issue #2 skeleton
│       ├── receipt_ocr/EXTENSION.md       # Issue #3 skeleton
│       ├── categorization/EXTENSION.md    # Issue #4 skeleton
│       ├── reconciliation/EXTENSION.md    # Future skeleton
│       ├── invoicing/EXTENSION.md         # Future skeleton
│       └── reporting/EXTENSION.md         # Issue #5 skeleton
│
└── test/
    └── ledger.test.ts                     # Node:test unit tests (33 tests, all passing)
```

## Architecture

### Ledger Core (pi-agnostic)

The `ledger.ts` module is independent of pi and unit-testable. It provides:

- **Account management:** hierarchy, type inheritance, colon-path notation
- **Transaction posting:** validation, balance enforcement, threshold gate, anomaly logging
- **Queries:** balances, transaction lists, account queries
- **Database:** SQLite with WAL mode, foreign key constraints, automatic initialization

### Pi Extension

The `index.ts` module adapts the ledger to pi's tool interface:

- Converts major (dollars) to minor (cents) at boundaries
- Registers 5 tools with typebox schemas
- Opens/closes ledger on session lifecycle
- Surfaces errors as tool errors (sets `isError`)

### Money Handling

- **Storage:** Integer minor units (cents) in the database
- **Tool inputs:** Major units (dollars) as floats
- **Conversion:** Immediate `toMinor()` on input, `toMajor()` on output
- **Precision:** 2 decimal places; `Math.round()` handles 0.1 + 0.2 edge cases

### Config and Policy

- **`config/settings.yaml`:** Human-facing metadata (DB path, currency, model note)
- **`config/policies.yaml`:** Auto-post threshold (the source of truth; env override wins)
- **`memory/anomaly_log.json`:** Append-only JSON log of blocks/flags; readable by human or later issues

## Key Design Decisions

1. **Double-entry invariant is enforced at write time** (not advisory). Invalid posts are rejected and logged.

2. **Auto-post threshold is code-enforced** (not deferred to another issue). Per AGENTS.md hard rule #1.

3. **Append-only ledger in v1** — no editing/deleting. Corrections use reversing entries.

4. **Repo-local pi** — no global install. All state lives in the repo; `.pi/extensions/` is auto-discovered.

5. **TypeScript with no compile step** — pi's jiti loader handles `.ts` directly. Tests use tsx for TypeScript support.

6. **Single-currency v1** — major/minor unit conversion is simple. Multi-currency and FX are out of scope.

## Future Issues

- **Issue #2 (Bank Sync):** Import transactions from bank statements
- **Issue #3 (Receipt OCR):** Extract transaction data from receipts/invoices
- **Issue #4 (Categorization):** Auto-categorize transactions using vendor rules
- **Issue #5 (Reporting):** Generate financial statements and tax exports

## References

- [AGENTS.md](./AGENTS.md) — Agent identity and hard rules
- [BRAIN.md](./BRAIN.md) — Domain knowledge (chart of accounts, types, currency)
- [workflows/setup_ledger.md](./workflows/setup_ledger.md) — Initialization workflow
- [.pi/extensions/bookkeeping/EXTENSION.md](./.pi/extensions/bookkeeping/EXTENSION.md) — Tool documentation

## License

TBD
