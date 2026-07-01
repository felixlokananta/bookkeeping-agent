# Plan: Receipt and invoice capture (image/PDF)

## Source
GitHub issue #3: https://github.com/felixlokananta/bookkeeping-agent/issues/3
"Receipt and invoice capture (image/PDF)" (enhancement). Issue 3 of 5; depends on issue #1
(merged — `bookkeeping` ledger core and its 5 tools). Can proceed in parallel with issue #2
(`bank_sync`, already merged) — no dependency between them.

Clarifications gathered before planning:
- **PDF support:** the pi tool-result content model only has `TextContent`/`ImageContent`
  (`pi-ai/dist/types.d.ts`) — no document/PDF content type — and no PDF-rasterization library
  is in `package.json`. V1 supports image files only (png/jpg/etc via vision). A `.pdf` input
  throws a clear "PDF not yet supported, convert to an image first" error rather than silently
  mis-extracting or adding a new rasterization dependency. Full PDF support is a follow-up.
- **Source file reference:** add a nullable `source_path TEXT` column to `transactions`
  (`bookkeeping/schema.ts`), threaded through `postTransaction` as an optional param. This is
  the one change to the issue #1 ledger core this issue requires.
- **Low-confidence gate:** code-enforced, not just conversational. The capture tool requires a
  `confidence: 'high' | 'low'` param (the agent's own self-assessment after reading the image).
  `'low'` blocks posting (throws, naming which fields are uncertain) unless re-called with
  `force: true` — same shape as `bank_sync`'s duplicate-block pattern in `AGENTS.md` rule 5.
- **Extraction mechanism:** matches the existing convention (issue #2's NL parsing) — no OCR
  library. A tool reads the receipt file from disk, resizes it via the existing
  `resizeImage` utility (`@earendil-works/pi-coding-agent/utils/image-resize.ts`), and returns
  it as `ImageContent` in the tool result so the vision-capable LLM extracts the fields itself.
  A second tool then posts the agent's confirmed/extracted draft.

## Summary
Add a `receipt_ocr` extension (currently an inert skeleton stub) with two tools: `read_receipt`,
which loads an image file from disk and returns it to the LLM as vision content for it to read
and extract a draft transaction (date, amount, payee, line items), and `capture_receipt`, which
posts the agent-confirmed draft as a balanced double-entry transaction (mirroring `bank_sync`'s
`Expenses:Uncategorized`/`Income:Uncategorized` convention), storing the original file path in a
new `transactions.source_path` column and requiring the agent to self-report extraction
confidence, blocking low-confidence posts unless explicitly forced.

## Goal
From a `pi` chat session, an operator can point the agent at a receipt/invoice image file (e.g.
`data/inbox/receipt1.jpg`); the agent reads it via `read_receipt`, states the extracted date,
total amount, vendor, and line items (if present) in chat for the operator to confirm or
correct, then calls `capture_receipt` to post it as a balanced entry against
`Expenses:Uncategorized` (or `Income:Uncategorized`) with the source file path retained on the
posted transaction. A low-confidence extraction (blurry image, missing fields) is blocked from
posting until the operator confirms and the agent re-calls with `force: true`; a `.pdf` input is
rejected with a clear "convert to image" error instead of being mis-parsed.

## Affected files
Create unless noted.
- `.pi/extensions/bookkeeping/schema.ts` (modify) — add `source_path TEXT` column to the
  `transactions` table DDL (nullable, no default needed).
- `.pi/extensions/bookkeeping/ledger.ts` (modify) — `postTransaction` accepts an optional
  `sourcePath?: string` opt, stored on insert; `Transaction`/`TransactionWithSplits` interfaces
  gain `source_path: string | null`.
- `.pi/extensions/receipt_ocr/EXTENSION.md` (modify — replaces the skeleton stub) — real doc:
  what this extension does, its 2 tools, the image-only/no-PDF limitation, the confidence gate.
- `.pi/extensions/receipt_ocr/package.json` — extension manifest, same shape as
  `bookkeeping/package.json` / `bank_sync/package.json`.
- `.pi/extensions/receipt_ocr/tsconfig.json` — same as the other two extensions.
- `.pi/extensions/receipt_ocr/capture.ts` — pi-agnostic core: `loadReceiptImage(path): { data:
  string; mimeType: string }` (reads + base64-encodes, resizes via `resizeImage`, rejects
  non-image mimetypes with the PDF-specific error message); `postReceiptEntry(ledger, opts): {
  transactionId, splitIds } | { lowConfidence: string[] }` (posts via `postTransaction`,
  inferring the offsetting Uncategorized account exactly like `bank_sync/ingestion.ts`, reusing
  `ensureUncategorizedAccount` — import from `bank_sync/ingestion.ts` rather than duplicating).
- `.pi/extensions/receipt_ocr/index.ts` — pi adapter; registers `read_receipt` and
  `capture_receipt`; own `session_start`/`session_shutdown` ledger handle (same
  `openLedger`/`closeLedger` pattern as the other two extensions).
- `AGENTS.md` (modify) — add `read_receipt`/`capture_receipt` to the tools list; add a hard rule
  (rule 6): low-confidence receipt extractions must be surfaced, never silently posted.
- `BRAIN.md` (modify) — document `source_path` as part of the transaction shape and the
  image-only (no PDF) limitation.
- `README.md` (modify) — add the two new tools, a receipt-capture example, note that source
  files are read from wherever the operator points (e.g. `data/inbox/`).
- `test/receipt_ocr.test.ts` — `node:test` unit tests for `capture.ts` against an in-memory
  ledger, plus a fixture image checked into `test/fixtures/`.

No changes to `.pi/extensions/bank_sync/*` — `ensureUncategorizedAccount` is imported from there,
not duplicated.

## Design decisions
1. **Two tools, not one.** `read_receipt` (loads + returns image content for the LLM to see) is
   separate from `capture_receipt` (posts the confirmed draft) — matches the repo's pattern of
   keeping "see the data" and "post the data" as distinct steps, and lets the agent show the
   extracted draft in chat between the two calls for operator confirmation (same conversational
   confirmation convention as `log_transaction`).
2. **No OCR/PDF library added.** Extraction is entirely the vision-capable LLM reading the image
   returned by `read_receipt`; `capture.ts` never parses pixels itself. PDFs are rejected by
   mimetype/extension check with an explicit unsupported-format error, not silently attempted.
3. **Confidence is agent-self-reported, code-enforced.** `capture_receipt` requires
   `confidence: 'high' | 'low'`. `'low'` without `force: true` returns/throws a
   `{ lowConfidence: [...] }`-style block (mirroring `bank_sync`'s duplicate-block shape) naming
   which of date/amount/payee the agent is unsure about, taken from an optional
   `uncertain_fields` param. This makes rule 6 code-enforced like rule 5, not merely a prompt
   instruction.
4. **Offsetting account and sign convention match `bank_sync`.** `capture_receipt` posts against
   `Expenses:Uncategorized`/`Income:Uncategorized` via the same `ensureUncategorizedAccount`
   used by `bank_sync`, imported directly (no duplication) — categorization proper is issue #4's
   job, matching issue #3's own "Out of scope: categorization logic (Issue 4)" line.
5. **Line items are not modeled in the schema.** No `line_items` table/column — issue #3 asks to
   extract them "where available" but the ledger only models a single balanced transaction with
   memo-level detail. Line items, if present, are joined into the split `memo` or transaction
   `description` as free text; a structured line-item breakdown is deferred (flagged below).
6. **`source_path` stores the path as given, not a copy of the file.** No file-copy-into-
   `data/processed/` step in this issue (the CSV `data/inbox/` convention was a directory
   naming hint only, not an ingestion contract) — `source_path` is whatever path the operator
   pointed the agent at, resolved from `process.cwd()` like `import_csv`'s `path` param. Moving
   confirmed receipts into `data/processed/` is a UX nicety, not required by the acceptance
   criteria ("retained and linked" is satisfied by storing the path), and is noted as a
   possible follow-up.

## Implementation steps

### Step 1: Schema + ledger core change
**Files:** `.pi/extensions/bookkeeping/schema.ts`, `.pi/extensions/bookkeeping/ledger.ts`
**What:** Add `source_path TEXT` to the `transactions` DDL. Extend `postTransaction`'s `opts`
with optional `sourcePath?: string`, include it in the INSERT, and add `source_path: string |
null` to the `Transaction`/`TransactionWithSplits` interfaces (and any SELECT that constructs a
`Transaction` — check `listTransactions`/`getBalance`'s query helpers for shared row-mapping).
**Why:** The only ledger-core change this issue needs; keeps everything else (balance/threshold
validation, splits) untouched.
**Details:** `source_path` is nullable so `post_transaction`/`log_transaction`/`import_csv`
(existing callers who never pass it) are unaffected. Existing `test/ledger.test.ts` should
still pass unmodified.

### Step 2: Extension scaffold
**Files:** `.pi/extensions/receipt_ocr/EXTENSION.md`, `package.json`, `tsconfig.json`
**What:** Replace the issue #1-era skeleton stub with a real manifest (name `receipt_ocr`, `type:
module`, `pi.extensions: ["./index.ts"]`), mirroring `bookkeeping/`/`bank_sync/` exactly.
**Why:** Makes the extension auto-loadable; keeps the three-extension layout consistent.

### Step 3: Receipt loading + posting core
**File:** `.pi/extensions/receipt_ocr/capture.ts`
**What:**
- `loadReceiptImage(path: string): { data: string; mimeType: string }` — resolves the path from
  cwd, reads the file, infers mimetype from extension (png/jpg/jpeg/gif/webp allow-list), throws
  a clear "PDF/unsupported format" error for `.pdf` or anything off the allow-list, calls
  `resizeImage` (from `@earendil-works/pi-coding-agent`) to keep the payload within reasonable
  size/dimension bounds, returns base64 `data` + `mimeType`.
- `postReceiptEntry(ledger, opts): { transactionId, splitIds } | { lowConfidence: string[] }` —
  `opts: { date, amountMinor, account, payee, memo?, sourcePath, confidence: 'high' | 'low',
  uncertainFields?: string[], force?, approved? }`. If `confidence === 'low' && !force`, returns
  `{ lowConfidence: uncertainFields ?? ['unspecified'] }` without posting. Otherwise infers the
  Uncategorized offsetting account via `ensureUncategorizedAccount` (imported from
  `bank_sync/ingestion.ts`) and calls `postTransaction` with `sourcePath`.
**Why:** Pi-agnostic, unit-testable in isolation, matches `bank_sync/ingestion.ts`'s shape.
**Details:** Re-throws `postTransaction` errors (imbalance/threshold) unchanged, same as
`postIngestedEntry`.

### Step 4: pi extension adapter and tools
**File:** `.pi/extensions/receipt_ocr/index.ts`
**What:** `export default function(pi: ExtensionAPI)`, own ledger handle on
`session_start`/`session_shutdown` (same pattern as the other two extensions). Registers:
- `read_receipt` — params: `path` (string). Calls `loadReceiptImage`; on success returns
  `content: [{ type: 'image', data, mimeType }, { type: 'text', text: 'Extract date, total
  amount, vendor/payee, and line items if visible.' }]`. On unsupported format, throws with the
  clear PDF/format error.
- `capture_receipt` — params: `date`, `amount` (major units, signed, same convention as
  `post_transaction`/`log_transaction`), `account`, `payee`, `source_path` (the path passed to
  `read_receipt`), `memo?` (free text — line items go here if extracted), `confidence: 'high' |
  'low'`, `uncertain_fields?` (string array), `force?` (default false), `approved?` (default
  false, passthrough). Calls `postReceiptEntry`; on `{ lowConfidence }`, throws naming the
  uncertain fields and instructing the agent to confirm with the user and re-call with `force:
  true`.
**promptGuidelines (both tools):**
- Always call `read_receipt` before `capture_receipt`; never guess receipt contents from the
  filename alone.
- State the extracted date/amount/payee/line-items in chat and get operator confirmation before
  calling `capture_receipt`.
- Set `confidence: 'low'` and list `uncertain_fields` honestly if the image is blurry, cropped,
  or any field couldn't be read clearly — do not guess a value and mark it `'high'`.
- `.pdf` files are not supported yet; ask the operator to provide an image export instead.
**Why:** Exposes capture to the LLM per acceptance criteria; matches existing extension
lifecycle and prompt-guideline conventions.

### Step 5: Docs
**Files:** `AGENTS.md`, `BRAIN.md`, `README.md`
**What:** Add `read_receipt`/`capture_receipt` to `AGENTS.md`'s tools list; add hard rule 6
("Low-confidence receipt extractions must be surfaced, never silently posted — `capture_receipt`
blocks on `confidence: 'low'` unless called with `force: true`"); document `source_path` and the
image-only limitation in `BRAIN.md`; add both tools plus a worked example to `README.md`.
**Why:** Keeps the "documented hard rule = code-enforced rule" convention from issues #1/#2.

### Step 6: Tests
**File:** `test/receipt_ocr.test.ts`, `test/fixtures/` (small sample receipt image)
**What:** `node:test` suite against `openLedger(':memory:')`, mirroring
`test/ledger.test.ts`/`test/ingestion.test.ts` setup/teardown.
**Why:** Locks in the confidence gate, source_path persistence, and format rejection without a
live pi session.

## Tests to write
- `loadReceiptImage` on a valid image file (fixture) returns base64 `data` + correct `mimeType`.
- `loadReceiptImage` on a `.pdf` path throws a clear unsupported-format error naming PDF
  explicitly, without attempting to read/parse it as an image.
- `loadReceiptImage` on an unsupported extension (e.g. `.txt`) throws a clear format error.
- `loadReceiptImage` on a missing file throws a clear file-not-found error.
- `postReceiptEntry` with `confidence: 'high'` posts a balanced entry: negative amount debits
  `Expenses:Uncategorized` and credits the source account; positive amount credits
  `Income:Uncategorized` and debits the source account.
- `postReceiptEntry` persists `source_path` on the created transaction (verify via a direct
  query or `listTransactions`).
- `postReceiptEntry` with `confidence: 'low'` and no `force` does not post anything and returns
  `{ lowConfidence }` naming the passed `uncertainFields`.
- `postReceiptEntry` with `confidence: 'low'` and `force: true` posts successfully.
- `Expenses:Uncategorized`/`Income:Uncategorized` are reused (not duplicated) across calls,
  consistent with `bank_sync`'s existing behavior (shared `ensureUncategorizedAccount`).
- `postReceiptEntry` for an amount exceeding the auto-post threshold is blocked by the inherited
  `postTransaction` gate (not silently posted), consistent with issue #1's rule 1.
- `postTransaction` (issue #1 core) still defaults `source_path` to `null` when not passed, and
  existing `test/ledger.test.ts`/`test/ingestion.test.ts` continue to pass unmodified.

## Risks and gotchas
- **PDF is a real gap, not just a v1 corner case.** The issue title explicitly says "image/PDF";
  rejecting PDFs with a clear error (rather than silently mishandling them) satisfies "flag
  unparseable extractions" from the acceptance criteria, but real invoices/receipts often arrive
  as PDF (email attachments, scanned statements) — this is a likely near-term follow-up
  (`pdf-to-img` or similar rasterization step) once a real usage gap is felt.
- **No structured line items.** Line items are flattened into free-text `memo`/`description`;
  if issue #4 or later reporting wants itemized data, that's a schema change for a future issue.
- **Confidence is self-reported by the LLM, not measured.** There's no independent verification
  that a model claiming `'high'` confidence is actually correct — this is a prompt-compliance
  risk inherent to vision-based extraction with no OCR fallback to cross-check against. Mitigated
  by requiring operator confirmation in chat before `capture_receipt` is called at all.
- **`source_path` is unvalidated free text on the ledger core.** Like `import_csv`'s `path`, no
  existence check or path-traversal restriction beyond what `loadReceiptImage` already did during
  `read_receipt` — consistent with the repo's local-single-operator trust model, but means a
  hand-crafted `capture_receipt` call could record a `source_path` that doesn't correspond to any
  real file (the tool doesn't re-verify the file at capture time, only at read time).
- **Fixture image adds a small binary file to the repo.** `test/fixtures/` will contain a sample
  receipt image — keep it minimal (a small synthetic/generated image, not a real receipt) to
  avoid bloating repo size or including any real personal data.
- **Third extension, third ledger connection.** `receipt_ocr/index.ts` opens its own `Ledger`
  handle to the same SQLite file, same as `bank_sync` — already established as safe under WAL in
  issue #2's risk notes.

## Out of scope
- PDF parsing/rasterization (explicitly deferred per the clarification above).
- Structured line-item storage (schema change, likely bundled with issue #4 categorization work
  if ever needed).
- Bulk/batch receipt scanning (explicitly out of scope per the issue: "bulk batch scanning
  workflows beyond one-at-a-time capture").
- Categorization logic beyond `Expenses:Uncategorized`/`Income:Uncategorized` (issue #4).
- Copying/moving the source file into `data/processed/` (path is stored as given; move-on-
  confirm is a possible follow-up, not required by the acceptance criteria).
- OCR library integration / deterministic confidence scoring (extraction and confidence are both
  LLM vision-based and self-reported, per the clarification above).
