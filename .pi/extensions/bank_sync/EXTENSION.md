# Bank Sync Extension

**Status:** Implemented (Issue #2)

This extension provides an ingestion layer on top of the `bookkeeping` ledger
(issue #1): conversational manual entry and bulk CSV/bank import. It does not
modify `bookkeeping`'s files — it imports and reuses `openLedger`,
`closeLedger`, `resolveAccount`, `createAccount`, `postTransaction`,
`listTransactions`, `toMinor`, `toMajor`, and `formatMoney` from
`.pi/extensions/bookkeeping/`.

## Tools

### `log_transaction`
Posts a single confirmed transaction as a balanced double-entry split against
the source account and an auto-created `Expenses:Uncategorized` or
`Income:Uncategorized` account. `amount` is major-unit and signed (negative =
money out, positive = money in), matching `post_transaction`'s convention.
The agent is expected to restate and confirm the parsed date/amount/payee/
account with the user before calling this tool — there is no separate draft/
preview tool state.

### `import_csv`
Bulk-imports a bank/card CSV export from a local path (resolved from
`process.cwd()`, e.g. `data/inbox/chase_march.csv`). Column headers are
auto-detected (`date`/`posted date`/`transaction date`, `amount`,
`debit`/`credit`, `description`/`payee`/`name`/`memo`) with optional per-call
overrides. Every recognizable row is posted as an uncategorized entry;
malformed or unmapped rows are reported per-row in `errors` (row number +
reason) rather than aborting the whole import.

## The Uncategorized-account convention

Ingested transactions are posted as *real, balanced* ledger transactions, not
held outside the ledger as pending drafts. `Expenses:Uncategorized` and
`Income:Uncategorized` are created on first use via `bookkeeping`'s existing
`createAccount` (colon-path auto-parent-creation) and posted via the existing
`postTransaction`, so issue #1's invariants (balance, threshold gate, anomaly
log) apply unchanged. Issue #4 (categorization) will later re-categorize by
moving splits to more specific accounts.

## Dedup behavior

Both tools share a duplicate-detection core (`dedupe.ts`): a transaction is a
likely duplicate if, within a ± N day window (default 3) of the candidate
date, there is an existing transaction with a split on the same account for
the exact same signed amount (minor units) whose description fuzzy-matches
(normalized token overlap) the candidate description.

- `log_transaction` **blocks** (throws, naming the matched transaction) unless
  called with `force: true`.
- `import_csv` **skips** matched rows by default but always reports them in
  `skipped_duplicates` with the matched transaction id — surfaced for
  confirmation, never silently dropped. `force_duplicates: true` disables the
  skip for a whole import.

## Known limitations (see plan.md "Risks and gotchas" for detail)

- The CSV parser is a hand-rolled, quoted-field-aware line parser — not a
  full RFC4180 implementation (no multi-line quoted fields). Acceptable for
  typical single-line bank exports; a future issue can swap in a library if a
  real-world export breaks it.
- Fuzzy-description dedup is a heuristic (normalized token overlap), not
  exact; both tools always surface matches for confirmation rather than
  silently skipping in the single-entry path.
- This extension opens its own `Ledger`/`DatabaseSync` connection to the same
  SQLite file as `bookkeeping/index.ts` (own session lifecycle), which is
  safe under WAL mode but means two open connections exist during a session.
