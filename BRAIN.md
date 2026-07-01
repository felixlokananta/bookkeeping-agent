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

`Expenses:Uncategorized` and `Income:Uncategorized` are part of the working chart. Ingested
transactions post as real, balanced double-entry transactions against these accounts (or a matched
category account if auto-categorization applies; see below) rather than being held outside the ledger
as pending drafts.

As of issue #11, `log_transaction` and `import_csv` consult learned vendor rules at ingestion time.
A high-confidence rule (`hits >= 2`) matching the payee/description will auto-post the transaction
directly to the matched category account (if its type matches the transaction kind: expense→expense
account, income→income account), skipping the Uncategorized round-trip entirely. This provides
immediate categorization for known vendors. Transactions with no matching rule, low-confidence rules,
or type mismatches still post to `Expenses:Uncategorized` or `Income:Uncategorized` as before. Issue #4
(categorization) tools can later re-categorize Uncategorized splits or correct already-categorized ones.

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

## File Format Support (Issue #3 — Receipt Capture, Issue #12 — PDF Support)

The `read_receipt` tool supports **image and PDF files:**
- **Supported:** PNG, JPG, JPEG, GIF, WebP, PDF (first page only)
- **Not supported:** Other document/office formats (e.g. DOCX, XLSX)

PDF files are rasterized to PNG using the `pdf-to-img` library. Multi-page PDFs extract the first
page only; the response includes a note if the PDF has more than one page. Corrupted or
password-protected PDFs are rejected with a clear error. Other unsupported formats are explicitly
rejected with a clear error message.

## Currency and Precision

- **Base currency:** USD (configurable in `config/settings.yaml`)
- **Precision:** 2 decimal places (cents); all monetary amounts are stored as integer minor units (cents) internally.
- **Fiscal year:** Calendar year (January–December; refinable in future issues)

## Key Concepts

- **Normal balance:** The direction (debit or credit) that increases an account. E.g., Assets increase with debits, Liabilities with credits.
- **Natural balance:** The balance shown to a user, always positive when the account is "full" (e.g., a $100 checking account shows +100, not -100). The raw database sum is adjusted by the normal balance direction.
- **Balanced transaction:** A transaction where total debits == total credits (always sums to zero in the database).

## Reporting and Financial Statements (Issue #5)

The `reporting` extension provides four tools for financial analysis and tax compliance:
- `spending_by_category` — hierarchical expense breakdown with drill-down
- `income_statement` — P&L for a date range
- `balance_sheet` — Assets = Liabilities + Equity (with retained earnings calculation)
- `tax_year_export` — CSV export of income/expense splits for tax preparation

All reports read from the ledger without modifying it; no closing entries are posted (retained earnings is calculated at report time).

## Future Considerations (Out of Scope)

- Inventing a tax-code mapping taxonomy beyond the existing chart of accounts (issue #5 scope is categorized export only, not full tax integration)
- Multi-currency and foreign-exchange handling
- Recurring transactions and period-end closings
