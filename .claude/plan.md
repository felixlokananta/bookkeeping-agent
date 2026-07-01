# Plan: Categorization engine (Issue #4)

## Source
GitHub issue #4 — "Categorization engine" (felixlokananta/bookkeeping-agent).

## Summary
Add a `categorization` pi extension that auto-assigns categories (real Expenses/Income accounts) to transactions currently sitting in `Expenses:Uncategorized` / `Income:Uncategorized`, using payee-pattern rules learned from past corrections, with an explicit fallback path for the agent to classify new/ambiguous payees and a bulk-recategorize tool for reviewing a batch conversationally.

## Goal
New/existing uncategorized transactions can be categorized (rule match or agent-assisted) with a visible confidence level; user corrections are persisted to `memory/vendor_rules.json` and apply to future matching transactions; a batch of uncategorized/low-confidence transactions can be reviewed and resolved in one conversational pass; every categorization decision is explainable (which rule/reasoning produced it).

## Design decisions (confirmed with user)
1. **Re-categorization = direct in-place update.** No `category` column exists today — "categorizing" means UPDATE-ing a split's `account_id` away from `Expenses:Uncategorized`/`Income:Uncategorized` to a real leaf account. This applies both to first-pass categorization and later corrections. This is a deliberate, documented carve-out from AGENTS.md Hard Rule 4 ("never edit posted transactions... corrections require a reversing entry") — that rule is about correcting amounts/dates/existing real postings, not about filling in/refining which category an Uncategorized split belongs to. AGENTS.md will be updated to state this exception explicitly (mirroring how Hard Rule 6 documents the receipt confidence-gate carve-out).
2. **Rules + correction history live in `memory/vendor_rules.json`** (already a placeholder), not a new SQLite table — consistent with the existing `anomaly_log.json` JSON-side-store pattern.
3. **Post-hoc only, no ingestion hook.** `bank_sync/ingestion.ts` and `receipt_ocr/capture.ts` are untouched. New tools operate over already-posted Uncategorized splits.

## Affected files
- `.pi/extensions/categorization/EXTENSION.md` — replace skeleton with real docs (tools, rule format, examples).
- `.pi/extensions/categorization/package.json`, `tsconfig.json` — new, mirror `bank_sync`'s.
- `.pi/extensions/categorization/rules.ts` — new: pi-agnostic core. Rule schema, rule matching (payee/memo substring + normalized-token matching, no fuzzy-match dep), load/save `memory/vendor_rules.json` (path overridable via `BOOKKEEPING_VENDOR_RULES_PATH` env var for test isolation, same trick as anomaly log).
- `.pi/extensions/categorization/categorize.ts` — new: pi-agnostic core. `listUncategorized(ledger, opts)`, `suggestCategory(payee, memo, rules)` (rule-match with confidence), `applyCategory(ledger, transactionId, accountRef, opts)` (moves the Uncategorized split's `account_id`, records/updates a rule in `vendor_rules.json` from the payee), `bulkRecategorize(ledger, matcher, accountRef, opts)` (conversational batch resolve, e.g. "all Amazon charges under $20 → Office Supplies").
- `.pi/extensions/categorization/index.ts` — new: pi extension adapter, registers 3 tools: `list_uncategorized`, `suggest_category`, `apply_category` (covers both single-apply and bulk via an optional filter), following the `bank_sync/index.ts` pattern (own ledger handle, `session_start`/`session_shutdown`, typebox params, `promptGuidelines`).
- `memory/vendor_rules.json` — populated by the extension at runtime (starts as `{}`).
- `AGENTS.md` — add Hard Rule 7 (categorization confidence gate + append-only carve-out) and a new "Tools (Issue #4 — Categorization)" section, following the existing Rule 5/6 style.
- `README.md` — add a "Categorization (Issue #4)" section mirroring the ingestion/receipt sections; update the "Completed and Upcoming Issues" list and project structure tree.
- `package.json` — add `test/categorization.test.ts` to the `test` script's file list.
- `test/categorization.test.ts` — new.

## Implementation steps
1. Define the rule schema in `rules.ts`: `{ pattern: string (normalized payee substring), accountName: string, confidence: 'high' | 'low', hits: number, lastAppliedAt: string }[]` keyed in `vendor_rules.json` by normalized pattern. Implement `loadRules`/`saveRules` (JSON read/write, env-overridable path, default `memory/vendor_rules.json`), `normalizePayee` (lowercase, trim, strip punctuation), and `matchRule(payee, rules)` → best matching rule or `null`.
2. In `categorize.ts`, implement `listUncategorized(ledger, opts?: { kind?, limit? })` using `listTransactions`/direct SQL joined against the Uncategorized account ids (via `resolveAccount`/`ensureUncategorizedAccount`-equivalent lookup) to return transactions with their Uncategorized split.
3. Implement `suggestCategory(payee, memo, rules)`: run `matchRule`; if a rule matches, confidence `'high'` if `hits >= 2` else `'low'`, with an `explanation` string (which pattern matched). If no rule matches, return `{ matched: false }` so the calling pi agent falls back to its own reasoning using the transaction context (amount/payee/date/memo) it already has — no LLM call inside the tool.
4. Implement `applyCategory(ledger, transactionId, accountRef, opts?: { recordRule?: boolean })`: resolve/auto-create `accountRef` via `resolveAccount`/`createAccount` (colon-path), `UPDATE splits SET account_id = ? WHERE transaction_id = ? AND account_id IN (Uncategorized ids)`, throw if the transaction has no Uncategorized split (nothing to categorize). By default, upsert a rule into `vendor_rules.json` keyed on the transaction's normalized description (increment `hits` if it already exists and matches the same accountName; if it conflicts with an existing pattern pointing elsewhere, overwrite pattern → this is the "correction" path).
5. Implement `bulkRecategorize(ledger, filter: { payeeContains?: string; maxAmountMinor?: number; kind? }, accountRef)`: query Uncategorized transactions matching the filter (case-insensitive description substring + optional abs-amount ceiling), call `applyCategory` on each, return `{ updated: number; transactionIds: number[] }`.
6. Build `index.ts`: register `list_uncategorized` (params: kind?, limit?), `suggest_category` (params: transactionId — looks up its Uncategorized split's payee/memo, calls `suggestCategory`), `apply_category` (params: transactionId?, filter?, accountName, force? — routes to `applyCategory` for a single id or `bulkRecategorize` when `filter` is given). `apply_category` is always an explicit user-confirmed instruction (not an unprompted inference), so no separate low-confidence gate is needed — unlike `capture_receipt`'s `force` gate over its own extraction confidence.
7. Update `AGENTS.md`: add Hard Rule 7 documenting the append-only carve-out for categorization (Uncategorized splits' `account_id` may be updated in place; this is filling in missing classification, not correcting a mistaken amount/date) and add the "Tools (Issue #4)" section describing `list_uncategorized`/`suggest_category`/`apply_category` with an example of the "recategorize all Amazon charges under $20 as Office Supplies" conversational flow.
8. Update `README.md`: new section per the pattern of the Ingestion/Receipt sections, mark Issue #4 as done in "Completed and Upcoming Issues", update the project structure tree to show the real `categorization/` extension contents.
9. Write `test/categorization.test.ts` (node:test, `:memory:` ledger via `openLedger(':memory:')` in `beforeEach`/`closeLedger` in `afterEach`, `BOOKKEEPING_VENDOR_RULES_PATH` pointed at a `mkdtempSync` temp file per test for isolation) and add it to `package.json`'s test script.

## Tests to write
- Rule matching: normalized substring match picks the right rule; no match returns `{ matched: false }`; confidence escalates from `'low'` to `'high'` after a rule accumulates ≥2 hits.
- `applyCategory` moves a transaction's split from `Expenses:Uncategorized` to a real category account, leaves the transaction's amount/date/description untouched, and creates the target account via colon-path if it doesn't exist yet.
- `applyCategory` on a transaction with no Uncategorized split throws.
- Applying a category persists/updates a rule in the rules store keyed on the transaction's payee, and a later transaction with a similar payee gets suggested that rule.
- Correcting a category (re-applying a different account to an already-categorized transaction) updates the rule's target account (last-write-wins) rather than duplicating rules.
- `bulkRecategorize` with a payee-substring + max-amount filter only updates matching transactions, leaves non-matching Uncategorized transactions untouched, and returns the correct count/ids.
- `listUncategorized` returns only transactions whose split account is `Expenses:Uncategorized`/`Income:Uncategorized`, filterable by kind.

## Risks and gotchas
- Two SQLite connections to the same file under WAL (categorization extension opens its own ledger handle, same as `bank_sync`/`receipt_ocr` already do) — known-safe pattern already in use, no new risk.
- Direct in-place `account_id` mutation is a deliberate, narrow exception to the append-only hard rule; must be documented in `AGENTS.md` so it isn't mistaken for a violation later, and must never be used to change `amount`/`date`/`description` — only `account_id` on Uncategorized-rooted splits.
- No fuzzy-matching dependency exists in `package.json`; rule matching is hand-rolled normalized-substring matching. Good enough for exact/near-exact payee repeats (the common case); genuinely fuzzy typo-tolerant matching is out of scope for this pass.
- `vendor_rules.json` is unbounded — no eviction/size cap is being added; acceptable for v1 given the single-user, single-repo scope.
- `bulkRecategorize`'s filter DSL is intentionally minimal (payee-substring + amount ceiling + kind) to satisfy the issue's example; it is not a general query language.

## Out of scope
- Reporting (Issue #5).
- Auto-categorization at ingestion time (post-hoc only, per confirmed decision).
- Calling an external LLM/classifier from inside the tool code — "agent-assisted classification" is satisfied by the calling pi agent itself reasoning over the transaction context handed to it by `suggest_category`'s `matched: false` response; no in-tool inference is added.
- Fuzzy/typo-tolerant string matching (no new dependency added).
- A dedicated undo/history-browsing tool for past rule changes beyond what's visible in `vendor_rules.json` itself.
