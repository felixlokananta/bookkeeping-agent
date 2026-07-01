# Plan: Reporting and tax export (Issue #5)

## Source
GitHub issue #5 — "Reporting and tax export" (felixlokananta/bookkeeping-agent). Issue 5 of 5, implemented last, depends on the already-merged ledger foundation (`bookkeeping` extension) and categorization engine (`categorization` extension).

## Summary
Build a new `reporting` pi extension with four report/export functions backed by the existing double-entry ledger — spending-by-category, P&L, balance sheet, and a tax-year CSV export — each exposed as a registered pi tool.

## Goal
An agent (or user) can request, for an arbitrary date range: (1) a spending-by-category breakdown with sub-account drill-down, (2) a P&L that reconciles with the ledger, (3) a balance sheet where Assets = Liabilities + Equity, and (4) a tax-year CSV export of categorized income/expenses — all via registered pi tools in the `reporting` extension, with passing automated tests proving the totals are correct.

## Affected files
- `.pi/extensions/reporting/index.ts` — new, tool registration (pattern copied from `.pi/extensions/categorization/index.ts`)
- `.pi/extensions/reporting/reports.ts` — new, core report logic (pure functions operating on `Ledger`, unit-testable, pattern copied from `.pi/extensions/categorization/categorize.ts`)
- `.pi/extensions/reporting/csv.ts` — new, minimal CSV writer (quoting/escaping) for the tax export
- `.pi/extensions/reporting/package.json` — new, `{ name: "reporting", type: "module", pi: { extensions: ["./index.ts"] } }`
- `.pi/extensions/reporting/tsconfig.json` — new, copy of categorization's tsconfig
- `.pi/extensions/reporting/EXTENSION.md` — update status from "Skeleton" to describe the four tools
- `test/reporting.test.ts` — new, unit tests for `reports.ts` functions plus tool-level smoke tests
- `package.json` — add `test/reporting.test.ts` to the `"test"` script's file list
- `BRAIN.md` — remove/update the line "Tax rules and category mappings (issue #5)" from the out-of-scope list, add a short note on how reports read the ledger

No changes to `.pi/extensions/bookkeeping/*` or `.pi/extensions/categorization/*` are needed — reporting reads existing tables via new queries in `reports.ts`, reusing `resolveAccount`, `formatMoney`, `toMajor`.

## Implementation steps

1. **`reports.ts`: account tree helpers**
   - `getDescendantAccountIds(ledger, accountId): number[]` — recursive query over `parent_id` (existing `getBalance({ includeChildren: true })` only covers one level deep; reports need arbitrary-depth drill-down, so this is a new recursive helper, not a reuse of `getBalance`).

2. **`reports.ts`: `spendingByCategory(ledger, { startDate, endDate, rootAccount? })`**
   - Sums splits by account for `Expenses` (or a given root, e.g. `Expenses:Food`) within the date range, using `getDescendantAccountIds` to include sub-accounts, grouped per leaf/branch account with a `children` breakdown.
   - Returns `{ accountName, totalMinor, children: [...] }[]`.

3. **`reports.ts`: `incomeStatement(ledger, { startDate, endDate })`** (P&L)
   - Sums all `income`-type account splits (credit-normal) and all `expense`-type account splits (debit-normal) within the date range.
   - Returns `{ incomeMinor, expenseMinor, netIncomeMinor, incomeByAccount, expenseByAccount }`.
   - Reconciliation check: netIncomeMinor must equal sum of splits into `Equity` accounts caused by these transactions is NOT required (no auto-close entries exist) — reconciliation is verified by the test asserting `incomeMinor - expenseMinor === netIncomeMinor` and cross-checking against `listTransactions` totals for the same range.

4. **`reports.ts`: `balanceSheet(ledger, { asOf })`**
   - Uses `getBalance` (existing function) for every top-level `asset`, `liability`, `equity` account plus their descendants (via `getDescendantAccountIds`), as of a given date.
   - Returns `{ assets: {...}, liabilities: {...}, equityAccounts: {...}, retainedEarnings, totalAssetsMinor, totalLiabilitiesAndEquityMinor }`.
   - `retainedEarnings` = net income from `incomeStatement` over all-time-to-`asOf` (since there are no closing entries, equity = stated equity accounts + cumulative net income) — this is what makes Assets = Liabilities + Equity balance, and must be covered by a test.

5. **`reports.ts`: `taxYearExport(ledger, { year })`**
   - Filters splits in `income`/`expense` accounts within `${year}-01-01`..`${year}-12-31`, one row per split: date, account name (category), description, amount (major units).
   - Returns row objects; does not write files itself (separation of concerns — `csv.ts` handles formatting, the tool handles file writing).

6. **`csv.ts`: `toCsv(rows, columns)`**
   - Minimal CSV serializer: header row + quoted/escaped fields (comma, quote, newline handling). No existing writer to reuse (`bank_sync/csv.ts` only parses); keep this small and dedicated to reporting's row shape rather than generic.

7. **`index.ts`: register four tools**, following the `categorization/index.ts` pattern (`session_start`/`session_shutdown` ledger lifecycle, `pi.registerTool` with typebox `parameters`, `content`/`details` return shape, try/catch rethrow):
   - `spending_by_category` — params `{ startDate, endDate, rootAccount? }`
   - `income_statement` — params `{ startDate, endDate }`
   - `balance_sheet` — params `{ asOf }`
   - `tax_year_export` — params `{ year, outputPath? }`; writes CSV to `outputPath` (default `data/exports/tax-export-<year>.csv`), creating `data/exports/` if needed; returns the file path and row count in `details`.

8. **Write `data/exports/.gitkeep`** if the directory isn't already tracked (check first — exploration found the dir exists but empty).

9. **Update `.pi/extensions/reporting/package.json`, `tsconfig.json`, `EXTENSION.md`** so the extension is no longer inert and is discoverable by pi.

10. **Update `package.json` `"test"` script** to include `test/reporting.test.ts`.

11. **Update `BRAIN.md`**: remove the "Tax rules and category mappings (issue #5)" out-of-scope line; add a one-line pointer to the reporting extension's tools for future context.

## Tests to write
All in `test/reporting.test.ts`, following `test/categorization.test.ts` conventions (`node:test`, in-memory ledger per test, `openLedger(':memory:')`, seed accounts/transactions via `createAccount`/`postTransaction`):

- `spendingByCategory`: post transactions into `Expenses:Food:Groceries` and `Expenses:Food:Restaurants`; assert the `Expenses:Food` rollup sums both children correctly, and date-range filtering excludes out-of-range transactions.
- `incomeStatement`: post income and expense transactions across two periods; assert only in-range transactions are counted, and `incomeMinor - expenseMinor === netIncomeMinor`.
- `balanceSheet`: post a set of transactions establishing asset/liability/equity balances plus income/expense; assert `totalAssetsMinor === totalLiabilitiesAndEquityMinor` (the accounting identity — the core acceptance criterion).
- `taxYearExport`: post transactions in and out of the target year; assert row count/contents match only the target year, and CSV output round-trips (header + correct quoting for a description containing a comma).
- Tool-level smoke test: call the exported `execute` functions from `index.ts` (or the underlying `reports.ts` functions if `categorization.test.ts` only tests the lib layer — match whichever pattern that file actually uses) to confirm each of the 4 tools runs without throwing on a minimal seeded ledger.

## Risks and gotchas
- `getBalance`'s `includeChildren` only sums one level of children (`ledger.ts:395-412`, comment literally says "not recursive") — do not reuse it as-is for multi-level category drill-down; write a proper recursive descendant lookup instead.
- No existing "tax category" or tax-line-mapping concept exists on accounts (`BRAIN.md` confirms this is explicitly deferred to issue #5, but the issue itself only asks for a categorized export, not a full tax-code mapping) — scope the tax export to grouping by existing chart-of-accounts category, not inventing a new tax-category taxonomy.
- Balance sheet equity must account for un-closed net income (no closing/retained-earnings entries exist in this ledger) — the identity Assets = Liabilities + Equity will only hold if net income is folded into equity at report time; this is the trickiest correctness point and needs a dedicated test.
- Amounts are minor units (cents) signed by debit(+)/credit(-) convention; reports must convert to natural balance (matching `getBalance`'s `naturalMinor` pattern) before summing income/expense, or signs will be inverted.
- `createAccount`'s colon-path auto-creates parents with the same type as the child if unspecified — tests need to create parent category accounts explicitly or let auto-create handle it consistently with existing test patterns.
- Extension is picked up automatically by pi once `package.json`/`index.ts` exist (no manual registration) — verify no other config (e.g. `.pi/settings.json` extension allowlist) needs updating.

## Out of scope
- Filing taxes or integrating with tax prep software directly (per issue's explicit "Out of scope").
- Inventing a tax-line/tax-code mapping taxonomy beyond the existing chart of accounts.
- Multi-currency reporting (ledger is single-currency per existing `config/settings.yaml` base currency).
- Report caching, scheduling, or a CLI wrapper beyond the pi tool registration.
- Recursive `getBalance` fix in `bookkeeping/ledger.ts` itself — reporting works around it locally rather than modifying the ledger foundation extension.
