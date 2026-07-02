# Reconciliation Extension

**Status:** Active (Issue #22)

This extension provides two read-mostly tools for bank/account reconciliation and ledger integrity verification.

## Tools

### `reconcile_account`

Reconcile a ledger account against a bank statement (balance-only or CSV export). Matches statement lines to ledger splits using tiered matching logic, computes balance discrepancy, and optionally marks matched entries as reconciled.

**Workflow:**
1. Call without `markReconciled` first to preview matches and discrepancies (no writes).
2. Review matched entries, ledger-only entries (in ledger but not statement), and statement-only entries (in statement but not ledger).
3. Once confirmed, re-call with `markReconciled: true` to persist the reconciliation run.

**Matching logic (tiered):**
- **Tier 1:** Exact amount match + transaction date within `windowDays` (default 3 days).
- **Tier 2 (fallback):** Exact amount match + fuzzy description match (using normalized text and stoplist tokens), regardless of date (for unmatched rows/splits only).

**Cross-source annotation:**
A matched transaction with a non-null `source_path` (i.e., posted via receipt capture) is flagged with `sourcedFromReceipt: true` and includes the receipt path, providing provenance for the ledger entry.

**Parameters:**
- `account`: Account name (e.g., "Assets:Checking")
- `periodStart`, `periodEnd`: Period boundaries (YYYY-MM-DD)
- `statementBalance`: Statement balance in major units (dollars)
- `statementPath` (optional): Path to CSV statement file
- Column overrides (optional): `date_column`, `amount_column`, `debit_column`, `credit_column`, `description_column`, `memo_column`
  - Same column detection and override pattern as `import_csv` in `bank_sync`.
- `windowDays` (optional): Date proximity window for Tier 1 matching (default: 3)
- `markReconciled` (optional): If true, persist the reconciliation run and mark matched splits as reconciled (default: false, preview mode)

### `verify_ledger`

Run period-end integrity checks on the ledger.

**Checks:**
1. **Unbalanced transactions:** Transactions whose split amounts do not sum to zero (double-entry violations).
2. **Orphan splits:** Splits referencing non-existent transactions or accounts.
3. **Trial balance:** Sum of all splits in the period (should be zero).
4. **Unexpected-sign accounts:** Accounts whose natural-balance display sign is negative (e.g., a debit-normal asset with a negative balance, which would typically indicate a liability).

**Parameters:**
- `asOf` (optional): Date cutoff (YYYY-MM-DD); if omitted, verifies the entire ledger.

## Data Model

Two append-only tables store reconciliation metadata:

**`reconciliation_runs`** (one row per reconciliation session)
- `id` (PK)
- `account_id` (FK to accounts)
- `period_start`, `period_end` (YYYY-MM-DD)
- `statement_balance_minor` (integer cents)
- `source_path` (nullable; path to statement CSV if provided)
- `created_at` (timestamp)

**`reconciliations`** (links splits to the run that confirmed them)
- `id` (PK)
- `run_id` (FK to reconciliation_runs)
- `split_id` (FK to splits)
- `created_at` (timestamp)

A split is "reconciled" iff it has a row in `reconciliations`. Multiple reconciliation runs can exist for the same account and period; a split confirmed in one run stays reconciled if a new run is created (row persistence). This design avoids adding a new append-only exception to `splits` and keeps reconciliation metadata cleanly separated.

## Design Notes

### No splits column mutation
Design decision 1: Use separate `reconciliation_runs`/`reconciliations` tables instead of adding a `splits.reconciled_at` column. Rationale: `splits` already has exactly one deliberate append-only exception (`account_id`, for categorization). A second exception would further clutter the append-only rules in AGENTS.md/CLAUDE.md. A separate table records the same fact — "split X was confirmed in reconciliation run Y" — as new, append-only rows, with zero changes to the `splits` schema or triggers.

### Explicit confirmation flag
Design decision 2: `reconcile_account` always computes and returns the diff/matches; it only inserts rows when called with `markReconciled: true`. This lets the first call be a pure preview, matching the codebase's existing "surface before mutate" pattern (duplicate detection, low-confidence receipts).

### Reused matching logic
Tier 1 matching is copied from `findLikelyDuplicates` in `bank_sync/dedupe.ts`; Tier 2 reuses the same `normalizeDescription`/`fuzzyMatch` functions. Statement amount sign convention matches `bank_sync/csv.ts`'s `parseAmountCents` (negative = money out, positive = money in), so amounts compare directly against split amounts on debit-normal accounts with no conversion.

### No recursive account rollup
`reconcile_account` operates on a single leaf account, not a parent with children. Bank/statement reconciliation is inherently per-account (statements are per-account), so the tool is scoped accordingly. If a user needs multi-account rollups, they should reconcile each account separately and then compare the aggregated results.

## Risks and Gotchas

- `verifyLedger` examines all accounts to check for unexpected-sign balances; this is O(n accounts) but necessary for data integrity checks.
- CSV parsing is lenient (skips malformed rows, matching `import_csv`'s behavior); use `markReconciled: false` preview to spot parsing issues before confirming.
- Trial balance should always be zero in a correctly-maintained ledger; if it isn't, unbalanced transactions are the likely culprit.
- **Only tested/designed against debit-normal (asset-type) accounts, e.g. `Assets:Checking`.** The statement-to-split amount comparison assumes no sign conversion is needed (see "Reused matching logic" above), which holds for asset accounts but not for credit-normal accounts (e.g. a credit card liability), where a statement's signed convention would need to be negated before comparing against split amounts. Reconciling a credit-normal account with this tool as-is will likely produce all-unmatched (`ledgerOnly`/`statementOnly`) results rather than a silently-wrong match — but this case isn't handled or tested.
