# Plan: Ingestion — manual entry and CSV/bank import

## Source
GitHub issue #2: https://github.com/felixlokananta/bookkeeping-agent/issues/2
"Ingestion — manual entry and CSV/bank import" (enhancement). Issue 2 of 5; depends on issue #1 (merged — the `bookkeeping` extension's ledger core and its 5 tools are live on `main`).

Clarifications gathered before planning:
- **Offsetting account for imports:** issue #2's own "Out of scope" line ("categorization logic beyond leaving entries uncategorized (Issue 4)") confirms the intended design — ingested transactions post as *real, balanced* double-entry transactions against `Expenses:Uncategorized` / `Income:Uncategorized`, not held outside the ledger as pending drafts. Issue #4 will later re-categorize by moving splits.
- **NL parsing:** the LLM parses natural language into structured tool params (matches the existing `post_transaction` convention — tools take structured data, not raw text). No NLP/regex parsing code needed.
- **CSV column mapping:** auto-detect common header names, with optional per-call override params. No new config file.
- **Dedup:** date window (± N days, default 3) + exact amount (minor units) + fuzzy/normalized description match. Surfaced for confirmation, not silently dropped.

## Summary
Add an ingestion layer on top of the issue #1 ledger: a `log_transaction` tool for confirmed conversational entry and an `import_csv` tool for bulk bank/card CSV import, both posting balanced double-entry transactions against new `Expenses:Uncategorized` / `Income:Uncategorized` accounts (auto-created on first use). Both tools share a duplicate-detection core (date-window + exact-amount + fuzzy-description) so re-importing overlapping CSVs or re-logging the same entry doesn't create duplicate ledger transactions, and both report errors/skips clearly instead of dropping rows silently.

## Goal
From a `pi` chat session, an operator can: describe a transaction in natural language ("$42 at Trader Joe's yesterday, from checking") and have `log_transaction` post it as a balanced entry (debiting/crediting `Assets:Checking` and the matching `Expenses:Uncategorized`/`Income:Uncategorized` account) after the agent confirms the parsed details in chat; import a CSV bank export via `import_csv` with columns auto-detected, getting every valid row posted as an uncategorized entry and a clear per-row error list for malformed/unmapped rows; and re-run the same (or an overlapping) CSV import without creating duplicate transactions, with skipped likely-duplicates reported by transaction id rather than silently dropped.

## Affected files
Create unless noted.
- `.pi/extensions/bank_sync/EXTENSION.md` (modify — currently a skeleton stub from issue #1) — real doc: what this extension does, its 2 tools, the Uncategorized-account convention, dedup behavior.
- `.pi/extensions/bank_sync/package.json` — extension manifest, same shape as `bookkeeping/package.json`: `{ "name": "bank_sync", "type": "module", "pi": { "extensions": ["./index.ts"] } }`.
- `.pi/extensions/bank_sync/tsconfig.json` — editor type-check only, same as `bookkeeping/tsconfig.json`.
- `.pi/extensions/bank_sync/index.ts` — pi adapter; registers `log_transaction` and `import_csv` tools; opens on the same ledger instance pattern as `bookkeeping/index.ts` (own `session_start`/`session_shutdown` using `openLedger`/`closeLedger` from `bookkeeping/ledger.ts`).
- `.pi/extensions/bank_sync/ingestion.ts` — pi-agnostic core: `ensureUncategorizedAccount`, `postIngestedEntry` (shared posting logic used by both tools).
- `.pi/extensions/bank_sync/dedupe.ts` — pi-agnostic: `findLikelyDuplicates(ledger, { account, amountMinor, date, description, windowDays })`.
- `.pi/extensions/bank_sync/csv.ts` — pi-agnostic: minimal CSV line parser (quoted-field aware), header auto-detection, date normalization (`YYYY-MM-DD` and `MM/DD/YYYY`), row-level parse-error reporting.
- `AGENTS.md` (modify) — add `log_transaction`/`import_csv` to the tools list; add a hard rule that likely duplicates must be surfaced, never silently skipped or silently posted.
- `BRAIN.md` (modify) — document `Expenses:Uncategorized`/`Income:Uncategorized` as part of the working chart, and the dedup tolerance (date window, amount, fuzzy description).
- `README.md` (modify) — add the two new tools, a CSV import example, and a note on where to put source files (`data/inbox/`).
- `workflows/import_transactions.md` — short runnable checklist: log one conversational entry, import a CSV, re-import the same CSV and confirm duplicates are skipped/reported.
- `test/ingestion.test.ts` — `node:test` unit tests for `dedupe.ts`, `csv.ts`, and the ingestion core, against an in-memory ledger.

No changes to `.pi/extensions/bookkeeping/{ledger,schema,policy,money}.ts` or its tools — `Expenses:Uncategorized`/`Income:Uncategorized` are created via the existing `createAccount` (colon-path auto-parent-creation already supports this) and posted via the existing `postTransaction`, so issue #1's invariants (balance, threshold gate, anomaly log) apply to ingested transactions unchanged.

## Design decisions
1. **Sign convention matches `post_transaction`.** `amount` is major-unit, signed: negative = money out (expense), positive = money in (income/deposit) — same convention the LLM already knows from `post_transaction`'s `promptGuidelines`. The offsetting account is inferred from the sign, no separate `direction` param: negative amount → debit `Expenses:Uncategorized`; positive amount → credit `Income:Uncategorized`.
2. **No draft/preview tool state.** Confirmation is conversational (the agent restates the parsed transaction and asks the user before calling the tool), same as the existing implicit convention — `post_transaction` has no preview step either. `promptGuidelines` on `log_transaction` instruct the agent to confirm date/amount/payee/account with the user first.
3. **Description doubles as payee.** No schema change; `transactions.description` stores the payee/description text used both for display and as the fuzzy-match input for dedup.
4. **Dedup blocks single entries, skips-and-reports bulk rows.** `log_transaction` throws (listing the matched existing transaction id) unless called with `force: true`. `import_csv` skips a matched row by default (not posted) but always includes it in a `skipped_duplicates` result list with the matched transaction id — "surfaced for confirmation," never silently dropped. `force_duplicates: true` disables the skip for a whole import.
5. **CSV parsing is hand-rolled, not a new dependency.** A minimal RFC4180-ish line parser (quoted fields, embedded commas, doubled-quote escaping) is enough for typical bank exports; documented as a risk below rather than pulling in a CSV library for two column shapes.
6. **Auto-create Uncategorized accounts on demand.** `ensureUncategorizedAccount` tries `resolveAccount`, falls back to `createAccount` on `Expenses:Uncategorized` or `Income:Uncategorized` (parent `Expenses`/`Income` roots already exist in `DEFAULT_CHART`) — no `schema.ts` change.
7. **Threshold gate and anomaly log are inherited, not reimplemented.** Both tools call the existing `postTransaction`, which already enforces the auto-post limit and logs anomalies; a blocked row/entry surfaces the existing error (and, for CSV, is reported per-row rather than aborting the whole import). Both tools accept an optional `approved` passthrough param for the same reason `post_transaction` does.

## Implementation steps

### Step 1: Extension scaffold
**Files:** `.pi/extensions/bank_sync/EXTENSION.md`, `package.json`, `tsconfig.json`
**What:** Replace the issue #1 skeleton stub with the real extension manifest, mirroring `bookkeeping/`'s shape exactly (name `bank_sync`, `type: module`, `pi.extensions: ["./index.ts"]`).
**Why:** Makes the extension auto-loadable by pi once `index.ts` exists; keeps convention consistent with the only other extension in the repo.

### Step 2: CSV parsing core
**File:** `.pi/extensions/bank_sync/csv.ts`
**What:** `parseCsvText(text): { header: string[]; rows: string[][] }` (quoted-field aware, comma-delimited); `detectColumns(header, overrides?)` matching case-insensitive aliases — date: `date`, `posted date`, `transaction date`; amount: `amount`; debit: `debit`; credit: `credit`; description: `description`, `payee`, `name`, `memo` — returns resolved column indices or throws a clear "no recognizable columns, pass overrides" error; `parseDate(raw): string` normalizing `YYYY-MM-DD` and `MM/DD/YYYY` to ISO, throwing on anything else; `parseAmountCents(row, cols): number` handling either a single signed `amount` column or separate `debit`/`credit` columns (credit − debit).
**Why:** Isolates the messy, bank-format-specific parsing from the ledger-posting logic; independently unit-testable.
**Details:** Pure functions, no `pi` or ledger imports. Row-level failures return a typed error object rather than throwing, so the caller (`ingestion.ts`/`index.ts`) can continue processing remaining rows and collect all errors.

### Step 3: Duplicate detection core
**File:** `.pi/extensions/bank_sync/dedupe.ts`
**What:** `findLikelyDuplicates(ledger, { account, amountMinor, date, description, windowDays = 3 }): Array<{ transactionId: number; date: string; description: string | null }>` — queries `listTransactions(ledger, { account, startDate: date - windowDays, endDate: date + windowDays })`, filters to transactions with a split on `account` whose `amount` matches `amountMinor` (sign-aware) exactly, then keeps only those whose `description` fuzzy-matches the candidate `description` (normalized lowercase/alphanumeric-only comparison; match if one normalized string contains the other, or they share a token of length ≥ 4).
**Why:** Shared by both tools so "duplicate" means the same thing in conversational and bulk paths.
**Details:** Pure date-arithmetic helper for the ± N day window (no timezone library — parse `YYYY-MM-DD` as UTC midnight). No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.

### Step 4: Ingestion posting core
**File:** `.pi/extensions/bank_sync/ingestion.ts`
**What:** `ensureUncategorizedAccount(ledger, kind: 'expense' | 'income'): Account` (resolve-or-create); `postIngestedEntry(ledger, { date, amountMinor, account, description, memo?, force?, approved? }): { transactionId, splitIds } | { duplicate: { transactionId, date, description } }` — runs `findLikelyDuplicates` first (skip if `force`), then builds the two-split payload (source account + inferred Uncategorized account, opposite signs) and calls the existing `postTransaction` from `bookkeeping/ledger.ts`.
**Why:** Single code path so `log_transaction` and each `import_csv` row behave identically; keeps sign/offset-account inference in one place (design decision #1).
**Details:** Re-throws `postTransaction` errors (imbalance/threshold) unchanged — callers don't need to know about `bookkeeping`'s internals beyond this one function.

### Step 5: pi extension adapter and tools
**File:** `.pi/extensions/bank_sync/index.ts`
**What:** `export default function(pi: ExtensionAPI)` opening its own ledger handle on `session_start` (same `openLedger`/`closeLedger` calls as `bookkeeping/index.ts`, same `BOOKKEEPING_DB_PATH`/`:memory:` resolution) and registering two tools.
**Why:** Exposes ingestion to the LLM per acceptance criteria; matches the existing extension's session lifecycle pattern.
**Details — tools:**
- `log_transaction` — params: `date` (YYYY-MM-DD), `amount` (major units, signed per design decision #1), `account` (source account, e.g. `Assets:Checking`), `payee` (string, used as description), `memo?`, `force?` (default false), `approved?` (default false, passthrough). Calls `postIngestedEntry`; on a `duplicate` result, throws an error naming the matched transaction id/date/description and instructing the agent to re-call with `force: true` if the user confirms it's not a duplicate. `promptGuidelines` state: confirm the parsed date/amount/payee/account with the user before calling; amount sign matches `post_transaction`; duplicates are blocked, not silently posted.
- `import_csv` — params: `path` (string, resolved from cwd, e.g. `data/inbox/chase_march.csv`), `account` (source account for every row), optional column overrides (`date_column`, `amount_column`, `debit_column`, `credit_column`, `description_column`), `date_window_days?` (default 3), `force_duplicates?` (default false), `approved?` (default false, passthrough per row). Reads the file, parses via `csv.ts`, then for each data row calls `postIngestedEntry`; accumulates `{ imported: [...], skipped_duplicates: [...], errors: [...] }` (errors include row number + reason: malformed date/amount, unresolvable account, imbalance/threshold-blocked). Returns a summary count in `content` and the full breakdown in `details`. Never throws for row-level problems — only for whole-file problems (file not found, no recognizable columns and no overrides given).

### Step 6: Docs
**Files:** `AGENTS.md`, `BRAIN.md`, `README.md`, `workflows/import_transactions.md`
**What:** Add `log_transaction`/`import_csv` to `AGENTS.md`'s tool list; add a hard rule ("Likely-duplicate imports must be surfaced, never silently skipped or silently posted"); document `Expenses:Uncategorized`/`Income:Uncategorized` in `BRAIN.md` alongside the existing 5-root chart, and the dedup tolerance; update `README.md` with both tools, a CSV smoke-test example, and a pointer to `data/inbox/` for source files; add `workflows/import_transactions.md` following the existing `setup_ledger.md` pattern.
**Why:** Keeps the documented hard rules code-enforced-and-documented convention from issue #1 (a rule stated only in prose is advisory).

### Step 7: Tests
**File:** `test/ingestion.test.ts`
**What:** `node:test` suite against `openLedger(':memory:')`, mirroring `test/ledger.test.ts`'s setup/teardown pattern.
**Why:** Locks in dedup correctness, sign/offset inference, and CSV edge cases without a live pi session.

## Tests to write
- `log_transaction` with a negative amount posts a balanced entry debiting `Expenses:Uncategorized` and crediting the source account by the same magnitude; positive amount credits `Income:Uncategorized` and debits the source account.
- `Expenses:Uncategorized`/`Income:Uncategorized` are auto-created on first use and reused (not duplicated) on subsequent calls.
- `log_transaction` called twice with the same date/amount/payee is blocked the second time (duplicate detected, nothing written); the same call with `force: true` posts.
- `log_transaction` duplicate check respects the date window: same amount/payee just outside the window (e.g. `windowDays=3`, 4 days apart) is NOT flagged as a duplicate.
- Fuzzy description match: `"Trader Joe's #123"` vs `"TRADER JOES 123 SEATTLE"` is flagged as a likely duplicate (normalized token overlap); an unrelated payee at the same date/amount is not.
- `import_csv` parses a well-formed CSV (single signed `amount` column) and posts every row as an uncategorized entry.
- `import_csv` parses a CSV with separate `debit`/`credit` columns and produces the correct signed amount.
- `import_csv` auto-detects common header variants (`Posted Date` vs `Date`, `Description` vs `Payee`) without overrides.
- `import_csv` with no recognizable columns and no overrides throws a clear file-level error (nothing posted).
- `import_csv` reports a malformed row (bad date, non-numeric amount) in `errors` with the row number, and continues processing the remaining valid rows.
- `import_csv` re-run on the same file skips every row as `skipped_duplicates` (each with the original transaction id) and posts nothing new; re-run with `force_duplicates: true` posts them again.
- `import_csv` row that exceeds the auto-post threshold (from `bookkeeping`'s existing gate) is reported in `errors`, not silently skipped, and the rest of the file still imports.
- CSV date parsing: `MM/DD/YYYY` and `YYYY-MM-DD` both normalize correctly; an unparseable date is a row-level error.

## Risks and gotchas
- **Hand-rolled CSV parser:** covers quoted fields with embedded commas and doubled-quote escaping (the common bank-export case) but is not a full RFC4180 implementation — multi-line quoted fields or unusual encodings could misparse. Acceptable for v1; note in `EXTENSION.md` so a future issue can swap in a library if a real-world export breaks it.
- **Fuzzy-match false positives/negatives:** normalized token-overlap dedup is a heuristic, not exact — a distinct $20 charge at two different coffee shops on the same day could theoretically collide if a token matches; conversely a heavily abbreviated bank description might not match its own CSV re-export. Both tools always report matches for confirmation (never silently skip in the single-entry path) to keep the failure mode visible rather than silent.
- **Two extensions, one ledger file:** `bank_sync/index.ts` opens its own `Ledger` handle (own `DatabaseSync` connection) to the same SQLite file as `bookkeeping/index.ts`, mirroring how each extension already manages its own lifecycle. SQLite handles concurrent connections to one file fine under WAL (already configured in `ledger.ts`), and `pi`'s tool execution is effectively serial per session, so this is safe but worth calling out — it means two open connections exist simultaneously during a session, not a shared handle.
- **Threshold-gate interaction:** a large CSV row crossing the auto-post limit is reported as an `errors` entry, not retried with approval automatically — re-running `import_csv` with `approved: true` re-imports the *whole* file with approval for every row, which could also approve genuinely-wrong large amounts; documented as a known limitation (per-row approval is out of scope, see below).
- **No payee/name schema field:** description/payee is stored in the existing `transactions.description` column; if issue #4 (categorization) later wants a dedicated payee column separate from free-text description, that's a schema change for that issue, not this one.
- **File path resolution for `import_csv`:** `path` is resolved relative to `process.cwd()` (same convention as `BOOKKEEPING_DB_PATH`/`data/bookkeeping.db`); no path traversal restriction is added since this is a local single-operator CLI tool, consistent with the rest of the repo's trust model.

## Out of scope
- Receipt/PDF/image parsing (issue #3).
- Actual categorization logic — categorized accounts beyond `Expenses:Uncategorized`/`Income:Uncategorized` (issue #4); vendor-rule learning (`memory/vendor_rules.json` stays a `{}` placeholder).
- Per-row/partial approval UX for threshold-blocked CSV rows (approval is whole-file, via the existing `approved` passthrough); multi-tier or per-account approval limits (already out of scope from issue #1).
- A dedicated `payee` schema column; multi-currency CSV imports; bank API/live sync (`bank_sync` is import-only, matching the issue's CSV scope — no live bank connections).
- Editing/deleting/reversing already-imported transactions (append-only ledger, unchanged from issue #1).
- A full RFC4180 CSV parser or a CSV parsing library dependency.
