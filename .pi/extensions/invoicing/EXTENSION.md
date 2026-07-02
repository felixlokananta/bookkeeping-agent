# Invoicing Extension

**Status:** Active (Issue #23)

This extension provides five tools for customer invoice management, payment recording, and accounts receivable (AR) aging analysis, all built on the existing double-entry ledger with no schema changes.

## Tools

### `create_invoice`

Create a customer invoice and post it as a balanced ledger transaction.

**Workflow:**
1. Provide customer name, line items (description, quantity, unit price), issue/due dates, and the income account to credit.
2. The tool auto-generates an invoice number (`INV-<YYYY>-<NNNN>`), computes the total, and posts a balanced transaction:
   - **Debit:** `Assets:Accounts Receivable:<Customer>` (creates if missing)
   - **Credit:** Supplied income account (creates if missing)
3. Persists invoice metadata (line items, total, dates, transaction ID) as a JSON file.
4. Subject to the auto-post threshold; use `approved: true` to override if needed.

**Parameters:**
- `customer`: Customer name
- `lineItems`: Array of `{ description, quantity, unitPrice }` (unitPrice in dollars)
- `issueDate`, `dueDate`: YYYY-MM-DD format
- `incomeAccount`: Account to credit (e.g., "Income:Services")
- `approved` (optional): Override auto-post threshold (default: false)

### `list_invoices`

List invoices with computed status and optional filtering.

**Status derivation (no stored status):**
- `open`: Full balance outstanding and due date not passed
- `partially paid`: Partial payment received (0 < remaining < total)
- `paid`: Fully paid (remaining <= 0)
- `overdue`: Due date passed and remaining > 0 (can overlay open or partially-paid)

**Parameters:**
- `customer` (optional): Filter by customer name
- `status` (optional): Filter by status (`open`, `partially paid`, `paid`, `overdue`)
- `asOf` (optional): Compute status as of this date (YYYY-MM-DD); defaults to today

### `record_payment`

Record a payment (full or partial) against an invoice.

**Workflow:**
1. Provide invoice number, bank account to debit, payment amount, and date.
2. Looks up the invoice and posts a balanced transaction:
   - **Debit:** Supplied bank account (must already exist; no auto-create)
   - **Credit:** `Assets:Accounts Receivable:<Customer>` (from invoice)
3. Transaction is linked to the invoice via `source_path`, so it appears in status/aging reports.
4. Multiple partial payments accumulate toward the invoice total.
5. Subject to auto-post threshold; use `approved: true` to override.

**Parameters:**
- `invoiceNumber`: Invoice number (e.g., "INV-2026-0001")
- `bankAccount`: Bank account to debit (must exist; no auto-create)
- `amount`: Payment amount in dollars
- `date`: Payment date (YYYY-MM-DD)
- `memo` (optional): Note for the split
- `approved` (optional): Override auto-post threshold (default: false)

### `render_invoice`

Render an invoice as formatted plain text (markdown-style).

**Output includes:**
- Invoice number, customer name, issue/due dates
- Line-item table (description, quantity, unit price, line total)
- Grand total
- Payment summary (amount paid, amount remaining)
- Current status

**Parameters:**
- `invoiceNumber`: Invoice number (e.g., "INV-2026-0001")
- `asOf` (optional): Render status as of this date (YYYY-MM-DD); defaults to today

### `ar_aging`

Generate an accounts receivable aging report.

**Report structure:**
- Buckets outstanding (non-paid) invoices by days outstanding:
  - 0-30 days
  - 31-60 days
  - 61-90 days
  - 90+ days
- Grouped by customer with per-bucket and grand totals
- Paid invoices are excluded

**Parameters:**
- `asOf` (optional): Report as of this date (YYYY-MM-DD); defaults to today

## Data Model

**No schema changes.** Invoices and payments are ordinary double-entry transactions with no new tables.

**Invoice storage:** JSON files in `memory/invoices/` (path overridable via `BOOKKEEPING_INVOICES_DIR` env var). One file per invoice, named `INV-<YYYY>-<NNNN>.json`.

**Invoice ↔ payment linkage:** Both the original invoice-posting transaction and every payment transaction against it have `source_path` set to the invoice's JSON file path. Status/balance for a given invoice is computed by querying the AR account for splits whose transaction's `source_path` equals that invoice's file path — required because AR is a shared per-customer account.

**Numbering:** `INV-<YYYY>-<NNNN>` where `YYYY` is the calendar year of `issueDate`. Sequence is scanned from the invoices directory and auto-incremented per year; no separate counter file.

## Design Notes

### No schema changes
Invoices and payments reuse the existing `transactions`/`splits` tables and the `source_path` column (already used by receipt capture for provenance). This keeps the ledger schema append-only and avoids adding new tables or exceptions to the append-only rules.

### Status derivation (no stored field)
Status is computed dynamically by querying splits on the AR account linked to the invoice by `source_path`. This ensures status always reflects current payments without requiring background updates or materialized views.

### source_path-based linkage
The `source_path` convention is load-bearing: if a payment is posted without it (e.g., manually via `post_transaction` instead of `record_payment`), that payment becomes invisible to invoice status/aging. The tool documentation emphasizes this convention but leaves enforcement to the operator.

### Per-customer AR accounts
AR is stored in `Assets:Accounts Receivable:<Customer>` accounts, one per customer. This allows multiple invoices per customer to share the same account while keeping payments attributable to specific invoices via `source_path`.

### Bank account auto-create asymmetry
`create_invoice` and `record_payment` auto-create AR and income accounts respectively, but `record_payment` does **not** auto-create the bank account — it throws if the account doesn't exist. This is a deliberate asymmetry to avoid silently creating arbitrary `Assets:*` accounts from a typo.

## Risks and Gotchas

- **source_path is load-bearing:** A payment posted manually without setting `source_path` to the invoice file path becomes invisible to invoice status/aging. Users must follow the `record_payment` convention or manually set `source_path` correctly.
- **Numbering race:** Invoice numbering by directory scan is subject to a benign race under concurrent writes. At v1 volumes this is acceptable; future versions may add a counter file.
- **No overpayment validation:** Payments larger than the remaining balance are accepted and produce a negative `remaining` balance (documented as a known gap). No refund flow exists.
- **Bank account requirement:** `record_payment` requires the bank account to already exist. If mistyped, the tool throws clearly, but this asymmetry with the auto-creating AR/income accounts is worth noting.
