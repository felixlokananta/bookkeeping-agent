# Domain Knowledge: Chart of Accounts and Ledger Model

## Account Types and Normal Balances

The ledger is organized into five account types, each with a normal (expected) balance direction:

| Type | Normal Balance | Example |
|------|---|---|
| **Asset** | Debit | Cash, Checking, Accounts Receivable |
| **Liability** | Credit | Credit Card, Accounts Payable, Loans |
| **Equity** | Credit | Owner's Capital, Retained Earnings |
| **Income** | Credit | Revenue, Sales, Investment Income |
| **Expense** | Debit | Salary, Rent, Supplies, Food |

**Double-entry principle:** Every transaction posts at least two splits (debit and credit) to different accounts, such that debits always equal credits.

## Chart of Accounts Structure

The default chart has five root accounts (one per type):

- `Assets` (type: asset)
- `Liabilities` (type: liability)
- `Equity` (type: equity)
- `Income` (type: income)
- `Expenses` (type: expense)

Sub-accounts are created using colon-path notation: `Assets:Checking`, `Expenses:Food:Groceries`, etc. Parent accounts are auto-created if missing.

### Uncategorized accounts (Issue #2 — Ingestion)

`Expenses:Uncategorized` and `Income:Uncategorized` are part of the working chart, auto-created on
first use by the `bank_sync` extension's `log_transaction` and `import_csv` tools. Ingested
transactions post as real, balanced double-entry transactions against these accounts rather than
being held outside the ledger as pending drafts. Issue #4 (categorization) will later move splits
from these accounts to more specific categories; until then, uncategorized balances are expected
and normal.

### Duplicate detection tolerance (Issue #2 — Ingestion)

`log_transaction` and `import_csv` share a duplicate-detection heuristic: a candidate entry is a
likely duplicate of an existing transaction if, within a date window (default ± 3 days) of the
candidate date, an existing transaction has a split on the same account for the *exact* same
signed amount (minor units), and its description fuzzy-matches the candidate's (normalized
lowercase/alphanumeric comparison; match if one normalized string contains the other, or they
share a token of length ≥ 4). This is a heuristic, not exact — matches are always surfaced for
confirmation rather than silently skipped or silently posted (see `AGENTS.md` hard rule 5).

### Source file reference (Issue #3 — Receipt Capture)

Every transaction has an optional `source_path` column (nullable, stored as `TEXT` in the ledger).
For transactions posted via `read_receipt` → `capture_receipt`, the `source_path` column retains
the file path to the original receipt/invoice image (e.g., `data/inbox/receipt1.jpg`), providing
an audit trail linking the ledger entry to its source document. Transactions posted via
`post_transaction`, `log_transaction`, or `import_csv` have `source_path = NULL` unless explicitly
provided. The path is stored as given (resolved from `cwd`), not validated or moved during posting;
it is the operator's responsibility to ensure the path is valid and the file is retained.

## File Format Support (Issue #3 — Receipt Capture)

The `read_receipt` tool supports **image files only:**
- **Supported:** PNG, JPG, JPEG, GIF, WebP
- **Not supported (v1):** PDF, and other document/office formats

PDF files are explicitly rejected with a clear "convert to image first" error, not silently
mis-parsed. Full PDF support (with rasterization) is a deferred follow-up once a usage gap is
felt in production.

## Currency and Precision

- **Base currency:** USD (configurable in `config/settings.yaml`)
- **Precision:** 2 decimal places (cents); all monetary amounts are stored as integer minor units (cents) internally.
- **Fiscal year:** Calendar year (January–December; refinable in future issues)

## Key Concepts

- **Normal balance:** The direction (debit or credit) that increases an account. E.g., Assets increase with debits, Liabilities with credits.
- **Natural balance:** The balance shown to a user, always positive when the account is "full" (e.g., a $100 checking account shows +100, not -100). The raw database sum is adjusted by the normal balance direction.
- **Balanced transaction:** A transaction where total debits == total credits (always sums to zero in the database).

## Future Considerations (Out of Scope, Issue #1)

- Vendor rules and categorization learning (issue #4)
- Tax rules and category mappings (issue #5)
- Multi-currency and foreign-exchange handling
- Recurring transactions and period-end closings
