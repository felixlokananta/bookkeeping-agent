# Receipt OCR Extension

**Status:** Issue #3 (approved)

This extension handles receipt and invoice image capture, extracting transaction data (date, amount, vendor/payee, line items) for double-entry posting.

## Capabilities

### Two tools:

#### `read_receipt`
Loads a receipt/invoice image file from disk, resizes it to reasonable bounds using the `resizeImage` utility, and returns it as image content for the LLM vision model to read and extract a draft transaction. The extracted date, total amount, vendor/payee, and line items (if visible) are stated in chat for operator confirmation before posting.

**Parameters:**
- `path` (string): File path to the receipt image, relative to the current working directory (e.g. `data/inbox/receipt1.jpg`).

**Returns:** Image content + extraction prompt for the LLM.

**Supported formats:** PNG, JPG, JPEG, GIF, WebP, and PDF (first page only). Multi-page PDFs are supported; only the first page is extracted for analysis. Other formats are rejected with a clear error.

#### `capture_receipt`
Posts the operator-confirmed draft transaction as a balanced double-entry entry against `Expenses:Uncategorized` (for expenses) or `Income:Uncategorized` (for income), storing the original file path in the transaction's `source_path` column.

**Parameters:**
- `date` (string): Transaction date (YYYY-MM-DD).
- `amount` (number): Total amount in major units, signed (e.g. `-50.25` for a $50.25 expense, `+100.00` for $100 income).
- `account` (string): Source account name (e.g. `Assets:Checking`).
- `payee` (string): Vendor or payer name.
- `source_path` (string): Path to the receipt image (same path passed to `read_receipt`).
- `memo` (string, optional): Free text, including any line items if extracted.
- `confidence` (`'high'` | `'low'`): Agent's self-assessment of extraction quality.
- `uncertain_fields` (string[], optional): List of fields (e.g. `['date', 'amount']`) the agent is unsure about (required if `confidence: 'low'`).
- `force` (boolean, optional, default false): If true, override low-confidence block. Does **not** override a likely-duplicate block.
- `force_duplicate` (boolean, optional, default false): If true, override a likely-duplicate block. Independent of `force` — confirming a low-confidence extraction does not also confirm it isn't a duplicate, so each gate needs its own explicit confirmation.
- `approved` (boolean, optional, default false): Passthrough to ledger auto-post threshold gate (set true if amount exceeds threshold and operator approves).

**Returns:** `{ transactionId, splitIds }` on success, `{ lowConfidence: [...] }` if blocked by low confidence (requires `force: true`), or `{ duplicate: { transactionId, date, description } }` if a likely duplicate is found (requires `force_duplicate: true`).

**Duplicate detection.** Before posting, `capture_receipt` checks for a likely duplicate — an existing transaction on the same account with the exact same signed amount, within a ±3-day window, whose description fuzzy-matches the payee (reusing `findLikelyDuplicates` from `bank_sync`). This catches both the same receipt being captured twice and a receipt overlapping a transaction already imported from a bank CSV (or vice versa). A likely duplicate is always surfaced to the operator, never silently skipped or posted; re-call with `force_duplicate: true` only after the operator confirms it isn't a duplicate.

## Limitations

- **PDF first page only.** Multi-page PDFs are supported via rasterization using `pdf-to-img`; only the first page is extracted for analysis. If more detailed analysis of subsequent pages is needed, the operator must manually split the PDF and re-upload individual pages.

- **Structured line items not modeled.** Line items are extracted where visible and included as free text in the split `memo` or transaction `description`; a dedicated line-items table is deferred.

- **Confidence is self-reported, code-enforced.** The agent assesses `confidence: 'high' | 'low'` after reading the image. `'low'` confidence blocks posting unless the agent explicitly confirms with the operator and re-calls with `force: true`. This is a prompt-compliance matter — there is no independent OCR verification of the extracted values.

## Design notes

- **No OCR library.** Extraction is entirely the LLM vision model reading the image; `capture.ts` never parses pixels itself.

- **Reuses bank_sync's uncategorized accounts.** Offsetting accounts (`Expenses:Uncategorized` / `Income:Uncategorized`) are managed via `ensureUncategorizedAccount` from `bank_sync/ingestion.ts`, ensuring they are consistent across both extensions.

- **Source path is stored as given.** The path is recorded as the operator provided it (e.g. `data/inbox/receipt1.jpg`), resolved from the current working directory. No file copy or move into `data/processed/` is performed; that is a possible UX follow-up.

- **Signature matches `bank_sync` duplicate-blocking pattern.** Like `bank_sync`'s low-confidence gate, the `'low'` confidence check returns a structured error block (naming uncertain fields) rather than throwing, allowing the agent to surface and resolve the issue with the operator.
