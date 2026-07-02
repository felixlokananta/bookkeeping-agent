# Bookkeeping Agent

A SQLite-backed double-entry ledger with a natural language interface via the `pi` coding agent.

## Overview

This project provides a complete accounting system with:
- Double-entry ledger enforcing balanced transactions (debits == credits)
- Chart of accounts with nested sub-account support
- Automatic approval threshold for high-value transactions
- Append-only transaction history (no editing/deleting in v1)
- Natural language interface through the `pi` agent

**New to the agent?** See [INSTRUCTIONS.md](./INSTRUCTIONS.md) for scenario-based examples (logging
an expense, importing a CSV, capturing a receipt, categorizing charges, pulling reports) showing
what to type and what to expect back.

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

**Preferred:** run via `scripts/run_agent.sh` (or `npm run agent`), which passes `--no-builtin-tools` so only the core ledger and ingestion tools are exposed:

```bash
npm run agent        # bash scripts/run_agent.sh
```

This is both a safety measure (a bookkeeping assistant has no reason to run shell commands or edit arbitrary files) and a reliability fix: some tool-calling models degrade badly once the tool list grows past ~5-6 tools, silently describing a call in plain text instead of invoking it. We verified this against a local vLLM Qwen model — with pi's full built-in toolset (bash/read/edit/write) mixed in, it failed to properly call `list_accounts` in ~2 of 3 tries; restricted to just the 5 ledger tools, it was reliable across repeated tries.

`npx pi` / `npm run pi` (without `--no-builtin-tools`) still work if you need the coding tools too, but expect lower tool-calling reliability on smaller/local models when you do.

**First run:** You'll see a trust prompt asking to enable the `.pi/extensions/bookkeeping` extension. Accept to proceed. The database will be auto-initialized with the default chart of accounts.

### If tool calls aren't working reliably

If the agent describes a tool call in plain text instead of invoking it (e.g. prints `` `list_accounts` `` or similar instead of returning results), the model likely isn't emitting a structured tool call. To diagnose independent of `pi`, send the same request shape directly to your provider's OpenAI-compatible endpoint with `curl` (`stream: true`, the same `tools` array) and check whether the response has a populated `tool_calls` field or leaks call syntax into plain `content` text. If direct `curl` calls work but `pi` doesn't, suspect prompt/toolset size (see above) before assuming a protocol bug.

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

## Ingestion: Manual Entry and CSV Import (Issue #2, with Issue #11 auto-categorization)

The `bank_sync` extension adds two tools on top of the ledger for getting transactions in:
`log_transaction` (single confirmed conversational entry) and `import_csv` (bulk bank/card CSV
import). Both post real, balanced double-entry transactions against the source account and either:
- A matched category account (if a high-confidence vendor rule from issue #4 matches the payee), or
- An auto-created `Expenses:Uncategorized` / `Income:Uncategorized` account (fallback).

As of issue #11, high-confidence rules (`hits >= 2`) are applied at ingestion time, skipping the
manual categorization step for known vendors and improving the immediate accuracy of imported data.
Put source CSV files in `data/inbox/`.

#### `log_transaction`
Post a single confirmed transaction. Amount is major-unit and signed, same convention as
`post_transaction`: negative = money out (expense), positive = money in (income). If a high-confidence
vendor rule matches the payee, the transaction posts directly to that category account (skipping
Uncategorized); otherwise it posts to `Expenses:Uncategorized` or `Income:Uncategorized`.

**Example prompt:**
```
log a transaction: $42 at Trader Joe's yesterday, from checking
```

The agent restates the parsed date/amount/payee/account and confirms with you before calling the
tool — there is no separate preview/draft step. If the payee matches a learned vendor rule, the
agent notes which category the transaction will be posted to.

**Duplicate handling:** if a likely duplicate is found (same account, same amount, date within
3 days, fuzzy-matching description), the tool blocks and names the matched transaction:
```
Likely duplicate of existing transaction 12 (2024-06-29, Trader Joes 123 Seattle). Re-call with
force: true if the user confirms this is not a duplicate.
```
Re-call with `force: true` only if you've confirmed with the user it isn't a duplicate.

#### `import_csv`
Bulk-import a bank/card CSV export.

**Example prompt:**
```
import the CSV at data/inbox/chase_march.csv into Assets:Checking
```

**Behavior:**
- Columns are auto-detected: date (`Date`, `Posted Date`, `Transaction Date`), amount (`Amount`,
  or separate `Debit`/`Credit`), description (`Description`, `Payee`, `Name`, `Memo`). Pass
  `date_column`/`amount_column`/`debit_column`/`credit_column`/`description_column` overrides only
  if auto-detection fails.
- Each row posts to either a matched category account (if a high-confidence vendor rule matches
  the payee) or an uncategorized entry.
- Likely-duplicate rows are skipped by default and reported in `skipped_duplicates` with the
  matched transaction id — never silently dropped. Re-run with `force_duplicates: true` to post
  them anyway.
- Malformed rows (bad date, non-numeric amount, unresolvable account, threshold-blocked) are
  reported in `errors` with the row number; the rest of the file still imports.
- Only whole-file problems (file not found, no recognizable columns and no overrides) raise an
  error; row-level problems never abort the import.

**Example result:**
```
Imported 18 row(s), skipped 2 likely duplicate(s), 1 error(s) out of 21 row(s).
```

**Re-importing the same file:** every previously-imported row is now a likely duplicate and is
reported in `skipped_duplicates` instead of being posted again.

## Receipt and Invoice Capture (Issue #3)

The `receipt_ocr` extension adds two tools for capturing receipts and invoices via image upload:
`read_receipt` (load and extract) and `capture_receipt` (confirm and post).

#### `read_receipt`
Load a receipt or invoice image (or PDF) from disk for the LLM to read and extract transaction data.

**Supported formats:** PNG, JPG, JPEG, GIF, WebP, and PDF (first page only). Multi-page PDFs are
supported; only the first page is extracted for analysis.

**Example prompt:**
```
read the receipt at data/inbox/receipt_20260701.jpg
```

**Behavior:**
The agent calls `read_receipt` to load the image, then states the extracted date, total amount,
vendor/payee, and line items (if visible) in chat for operator confirmation. Never guess receipt
contents from the filename alone.

#### `capture_receipt`
Post the operator-confirmed extraction as a balanced double-entry transaction.

**Example prompt (after read_receipt):**
```
the receipt looks correct — post it:
- date: 2026-07-01
- amount: -45.99 (that's a $45.99 expense)
- payee: Trader Joe's
- from Assets:Checking
- confidence: high
```

**Behavior:**
- Posts against the source account and an auto-created `Expenses:Uncategorized` (for expenses) or
  `Income:Uncategorized` (for income) account, same as `log_transaction`.
- Stores the original receipt file path in the transaction's `source_path` column (audit trail).
- Requires agent self-assessment of extraction confidence: `confidence: 'high'` or `confidence:
  'low'`. Low-confidence posts are blocked unless called with `force: true` after operator
  confirmation (see `AGENTS.md` hard rule 6).
- Inherits the auto-post threshold gate from `post_transaction`; exceeding the limit requires
  `approved: true`.

**Confidence gate example:**
If the image is blurry or a field is missing, the agent sets `confidence: 'low'` and lists
`uncertain_fields: ['amount', 'payee']`. The tool blocks the post:
```
Low-confidence extraction blocked. Uncertain fields: amount, payee. Please confirm with the
user that these values are correct, then re-call with force: true to post anyway.
```

After operator confirmation, re-call:
```
the operator confirms: amount is $45.99, payee is Trader Joe's. re-call with force: true.
```

**Source files:** Receipt images are read from wherever the operator points (e.g.,
`data/inbox/`, an external drive, a temp folder). The tool does not move or copy files; the
path is stored as given. Moving confirmed receipts into `data/processed/` is a possible follow-up
(not required by v1).

## Categorization (Issue #4)

The `categorization` extension adds three tools for auto-assigning categories (real Expenses/Income
accounts) to transactions sitting in `Expenses:Uncategorized` / `Income:Uncategorized` using
payee-pattern rules learned from past corrections.

#### `list_uncategorized`
Show transactions awaiting categorization, optionally filtered by kind (expense/income).

**Example prompt:**
```
show me the uncategorized expenses
```

**Output:** A list of transactions with date, description, amount, and which Uncategorized account
they're in.

#### `suggest_category`
Look up a learned vendor rule for a transaction. Returns high/low confidence with the matched
pattern if a rule applies; otherwise returns "no match" (agent must reason).

**Example prompt:**
```
suggest a category for transaction 42
```

**Output (rule match):**
```
Suggested category for TX 42: Expenses:Office Supplies (confidence: high). Matched pattern "amazon" (4 hits)
```

**Output (no match):**
```
No learned rule matches transaction 42. You must reason over the transaction details and call
`apply_category` with your chosen account.
```

#### `apply_category`
Categorize a single transaction or bulk-categorize a filtered batch of transactions. Updates the
transaction's expense/income split to point at a real category account and records/updates a
learned rule in `memory/vendor_rules.json`. Works whether the split currently points at
`Expenses:Uncategorized`/`Income:Uncategorized` (first-pass categorization) or an already-assigned
real category — re-calling `apply_category` with a different `accountName` on an already-categorized
transaction is how you correct it.

**Example prompt (single):**
```
that Amazon charge is Office Supplies
```

The agent calls:
```
apply_category { transactionId: 42, accountName: "Expenses:Office Supplies" }
```

**Example prompt (bulk):**
```
categorize all Amazon charges under $20 as Office Supplies
```

The agent calls:
```
apply_category {
  filter: { payeeContains: "AMAZON", maxAmountMinor: 2000 },
  accountName: "Expenses:Office Supplies"
}
```

**Behavior:**
- Single categorization: moves one split and records a rule. Re-calling on an already-categorized
  transaction with a different `accountName` corrects it (moves the split again).
- Bulk categorization: moves multiple matching splits and records/updates the rule; per-row failures
  (e.g. an account-creation conflict) don't abort the batch and are reported in `failed`.
- If the target account does not exist, it is auto-created via colon-path (e.g., `"Expenses:Office Supplies"`).
- Rules are keyed on a generalized vendor pattern derived from the payee — normalized (lowercase,
  punctuation stripped) with trailing order/reference numbers dropped (e.g. `"AMAZON.COM #12345"`
  and `"AMAZON.COM #98765"` both key to `"amazon com"`), so repeat charges from the same vendor
  actually accumulate hits instead of each producing a distinct one-off pattern.
- Rules are learned on first application (`confidence: "low"`, `hits: 1`).
- Subsequent matching categorizations increment `hits` and escalate `confidence` to `"high"` once `hits >= 2`.
- Correcting a category (re-categorizing to a different account) overwrites the rule with `hits: 1` and `confidence: "low"` (last-write-wins).

All three tools work post-hoc — only over already-posted transactions. Categorization does not edit amounts, dates, or descriptions; only the split's `account_id` is updated (exception to the append-only rule; see `AGENTS.md` hard rule 7).

## Reporting and Tax Export (Issue #5)

The `reporting` extension adds four read-only tools for financial analysis and tax compliance. None
of them post or mutate the ledger.

#### `spending_by_category`
Hierarchical spending breakdown by expense category (or a custom root account) over a date range.

**Example prompt:**
```
show spending by category for 2026 so far
```

#### `income_statement`
Profit & loss for a date range: total income, total expenses, net income, and per-account breakdown.

**Example prompt:**
```
show the income statement for June 2026
```

#### `balance_sheet`
Assets/liabilities/equity as of a date. Retained earnings is computed on the fly from cumulative
net income (the ledger has no closing entries) and the response verifies Assets = Liabilities +
Equity.

**Example prompt:**
```
show the balance sheet as of 2026-06-30
```

#### `tax_year_export`
Exports income/expense splits for a tax year to a CSV file.

**Example prompt:**
```
export tax data for 2025
```

**Behavior:**
- Writes to `data/exports/tax-export-<year>.csv` by default, or an operator-supplied `outputPath`.
- `outputPath` is resolved and constrained inside `data/exports/`; paths that would escape that
  directory (e.g. via `..` segments or an absolute path elsewhere) are rejected.
- Each row is a split with date, category (account name), description, and amount.

## Unit Tests

Run the comprehensive test suite:

```bash
npm test
```

**Output:** Tests covering:
- Ledger initialization and seed chart
- Account creation and hierarchy
- Transaction posting and validation
- Balance queries and filtering
- Auto-post threshold gate
- Money conversion helpers
- Policy loading and anomaly logging
- Ingestion (manual entry, CSV import, duplicate detection)
- Receipt/invoice capture and confidence gating
- Categorization (rule learning, bulk apply, corrections)
- Reporting (spending breakdown, income statement, balance sheet, tax export)

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
│       ├── bank_sync/                     # Issue #2: ingestion (manual entry + CSV import)
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter (log_transaction, import_csv)
│       │   ├── ingestion.ts               # Uncategorized-account posting core
│       │   ├── dedupe.ts                  # Duplicate detection core
│       │   └── csv.ts                     # CSV parsing core
│       ├── receipt_ocr/                   # Issue #3: receipt/invoice capture; Issue #12: PDF support
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter (read_receipt, capture_receipt)
│       │   └── capture.ts                 # Receipt loading + posting core
│       ├── categorization/                # Issue #4: auto-categorization using vendor rules
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter (list_uncategorized, suggest_category, apply_category)
│       │   ├── categorize.ts              # Categorization core (list, suggest, apply, bulk)
│       │   └── rules.ts                   # Rule schema, matching, load/save
│       ├── reporting/                     # Issue #5: reporting and tax export
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter (spending_by_category, income_statement, balance_sheet, tax_year_export)
│       │   ├── reports.ts                 # Reporting core (reads ledger, no mutation)
│       │   └── csv.ts                     # CSV export core
│       ├── reconciliation/                # Issue #22: bank reconciliation and ledger verification
│       │   ├── EXTENSION.md
│       │   ├── package.json
│       │   ├── tsconfig.json
│       │   ├── index.ts                   # Pi extension adapter (reconcile_account, verify_ledger)
│       │   ├── reconcile.ts               # Reconciliation core
│       │   └── verify.ts                  # Ledger verification core
│       └── invoicing/                     # Issue #23: invoice generation and accounts receivable
│           ├── EXTENSION.md
│           ├── package.json
│           ├── tsconfig.json
│           ├── index.ts                   # Pi extension adapter (create_invoice, list_invoices, record_payment, render_invoice, ar_aging)
│           ├── invoices.ts                # Invoice creation, listing, and payment recording core
│           ├── aging.ts                   # AR aging report core
│           ├── render.ts                  # Invoice rendering core
│           └── store.ts                   # Invoice JSON storage and numbering
│
└── test/
    ├── ledger.test.ts                     # Node:test unit tests for the ledger core
    ├── ingestion.test.ts                  # Node:test unit tests for bank_sync
    ├── receipt_ocr.test.ts                # Node:test unit tests for receipt_ocr
    ├── categorization.test.ts             # Node:test unit tests for categorization
    ├── reporting.test.ts                  # Node:test unit tests for reporting
    ├── reconciliation.test.ts             # Node:test unit tests for reconciliation
    └── invoicing.test.ts                  # Node:test unit tests for invoicing
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

## Completed and Upcoming Issues

- **Issue #1:** Ledger core + 5 ledger tools ✓
- **Issue #2:** Ingestion (manual + CSV import) ✓
- **Issue #3:** Receipt/invoice capture (image support) ✓
- **Issue #4:** Categorization (auto-categorize transactions using vendor rules) ✓
- **Issue #5:** Reporting (financial statements and tax export) ✓
- **Issue #11:** Auto-categorize transactions at ingestion time ✓
- **Issue #12:** PDF support in receipt_ocr (first page only via rasterization) ✓
- **Issue #22:** Bank reconciliation and ledger verification ✓
- **Issue #23:** Invoice generation and accounts receivable ✓

## References

- [INSTRUCTIONS.md](./INSTRUCTIONS.md) — Scenario-based examples of interacting with the agent
- [AGENTS.md](./AGENTS.md) — Agent identity and hard rules
- [BRAIN.md](./BRAIN.md) — Domain knowledge (chart of accounts, types, currency, file formats)
- [workflows/setup_ledger.md](./workflows/setup_ledger.md) — Initialization workflow
- [.pi/extensions/bookkeeping/EXTENSION.md](./.pi/extensions/bookkeeping/EXTENSION.md) — Ledger tool documentation
- [.pi/extensions/bank_sync/EXTENSION.md](./.pi/extensions/bank_sync/EXTENSION.md) — Ingestion tool documentation
- [.pi/extensions/receipt_ocr/EXTENSION.md](./.pi/extensions/receipt_ocr/EXTENSION.md) — Receipt capture tool documentation
- [.pi/extensions/categorization/EXTENSION.md](./.pi/extensions/categorization/EXTENSION.md) — Categorization tool documentation
- [.pi/extensions/reporting/EXTENSION.md](./.pi/extensions/reporting/EXTENSION.md) — Reporting tool documentation

## License

TBD
