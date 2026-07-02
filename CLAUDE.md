# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A SQLite-backed double-entry ledger exposed as a `pi` coding-agent extension set — a natural-language bookkeeping assistant, not a traditional web app. There is no server/UI; the ledger is manipulated entirely through registered tools that the `pi` agent calls in response to chat.

## Commands

```bash
npm install                     # install deps (Node 24+ required for node:sqlite)
npm test                        # run full suite (tsx --test, all *.test.ts files listed explicitly in package.json)
npx tsc --noEmit -p tsconfig.json   # typecheck (CI runs this as a separate, mandatory step — tsx does NOT typecheck)
npm run agent                   # bash scripts/run_agent.sh — starts pi with --no-builtin-tools (safety + reliability, see below)
npm run pi                      # starts pi with full built-in toolset (bash/read/edit/write) — lower tool-calling reliability on small models
```

Run a single test file directly with `tsx --test test/<name>.test.ts` (or `node --test` if pre-transpiled). **When adding a new `test/*.test.ts` file, you must add it to the `"test"` script's file list in `package.json` — it will not run otherwise.**

CI (`.github/workflows/ci.yml`) runs, in order: `npm ci` → typecheck → `npm test` → `npm audit --audit-level=moderate`. A branch can pass `npm test` (tsx skips type errors) and still fail CI on the typecheck step — always run `npx tsc --noEmit -p tsconfig.json` before considering work done.

Do **not** install `pi` globally — this repo uses a local copy auto-discovered from `.pi/extensions/` via `.pi/settings.json` (`extensionsPath: ".pi/extensions"`).

## Architecture

### Extension-per-issue layout

Each feature lives in its own self-contained `pi` extension under `.pi/extensions/<name>/`, corresponding 1:1 to a GitHub issue, built in strict dependency order:

1. **`bookkeeping`** — ledger core (`ledger.ts`, `schema.ts`, `money.ts`, `policy.ts`). Pi-agnostic and independently unit-testable; every other extension imports from here rather than touching SQLite directly.
2. **`bank_sync`** — ingestion (`log_transaction`, `import_csv`), posts against auto-created `Expenses:Uncategorized`/`Income:Uncategorized`.
3. **`receipt_ocr`** — image-only receipt/invoice capture (`read_receipt`, `capture_receipt`); PDF explicitly rejected in v1.
4. **`categorization`** — moves splits out of the Uncategorized accounts using learned vendor-pattern rules (`memory/vendor_rules.json`).
5. **`reporting`** — read-only financial reports/tax export over the posted ledger (`spending_by_category`, `income_statement`, `balance_sheet`, `tax_year_export`).
6. **`reconciliation`** — bank reconciliation and ledger integrity verification (`reconcile_account`, `verify_ledger`); read-mostly, with optional persistence of reconciliation runs.

Each extension directory has its own `package.json` (`{ type: "module", pi: { extensions: ["./index.ts"] } }`) and `tsconfig.json`; `index.ts` is the only file that imports `@earendil-works/pi-coding-agent` and does the pi-facing adaptation. All actual logic lives in plain, pi-agnostic `.ts` modules alongside it (e.g. `categorize.ts`, `reports.ts`, `reconcile.ts`) so it can be unit-tested without a pi harness. `invoicing/` is still an inert skeleton (`EXTENSION.md` only, no `index.ts`/`package.json`) reserved for future issues.

**Extension `index.ts` pattern** (copy this when adding a tool): open the ledger in `pi.on('session_start', ...)` via `openLedger(process.env.NODE_ENV === 'test' ? ':memory:' : process.env.BOOKKEEPING_DB_PATH)`, close it in `session_shutdown`; register each tool with `pi.registerTool({ name, parameters: Type.Object({...}) /* typebox */, execute: async (_id, params) => ({ content: [...], details: {...} }) })`; convert major↔minor units at the tool boundary (`toMinor`/`toMajor`/`formatMoney` from `bookkeeping/money.ts`), never inside the ledger core.

### Ledger data model

Double-entry, SQLite (`node:sqlite`). `accounts(id, name, type, parent_id, normal_balance)` / `transactions(id, date, description, source_path)` / `splits(id, transaction_id, account_id, amount)`. Amounts are **signed integer minor units (cents)**: positive = debit, negative = credit; a balanced transaction's splits always sum to zero. Accounts use colon-path names (`Expenses:Food:Groceries`); `createAccount` auto-creates missing parents and inherits type from the root if unspecified.

`getBalance({ includeChildren: true })` in `ledger.ts` only sums **one level** of children — it is not recursive (there's a comment saying so). Anything needing arbitrary-depth rollup (e.g. reporting) must walk `parent_id` itself rather than relying on that flag.

"Natural balance" (what's shown to users) = raw signed amount adjusted by the account's `normal_balance` (debit-normal accounts show raw; credit-normal accounts show negated) — see `toNatural`-style conversions in `reporting/reports.ts` for the canonical pattern.

There are no closing/retained-earnings entries; the ledger is append-only forever. Anything needing an accounting identity across periods (e.g. `balance_sheet`'s Assets = Liabilities + Equity) computes retained earnings on the fly from cumulative net income rather than relying on posted closing entries.

### Hard rules (enforced in code, not just prompted)

Full detail in `AGENTS.md` (auto-loaded into every `pi` session) and `BRAIN.md` (domain knowledge, injected by the `bookkeeping` extension since it isn't an auto-loaded filename). The load-bearing ones for anyone touching ledger-adjacent code:

1. **Auto-post threshold** (`config/policies.yaml`, `auto_post_limit`, default $500, env override `BOOKKEEPING_AUTOPOST_LIMIT`) is a hard gate on `post_transaction` and everything that posts through it (`log_transaction`, `import_csv`, `capture_receipt`) — blocked without `approved: true`, and the block is logged to `memory/anomaly_log.json`.
2. **Splits must sum to zero.** Never fabricate a balancing figure; unbalanced posts are rejected and logged, not silently fixed.
3. **Append-only ledger** — no editing/deleting posted transactions/amounts/dates. The sole exception: categorization may mutate a split's `account_id` in place (moving it out of Uncategorized, or correcting an existing category) — see hard rule 7 in `AGENTS.md`.
4. **Likely duplicates and low-confidence receipt extractions must always surface to the operator**, never silently skip or silently post — both require an explicit `force: true` after confirmation.

### Test conventions

`node:test` + `node:assert`, one file per extension under `test/`. Standard scaffolding: `before`/`after` create a `mkdtempSync` tmp dir and point side-effect files (`BOOKKEEPING_ANOMALY_LOG_PATH`, `BOOKKEEPING_VENDOR_RULES_PATH`) at it so runs don't dirty the tracked `memory/*.json` files; `beforeEach` opens `openLedger(':memory:')` fresh, `afterEach` closes it. **Every test file that posts transactions near/above the auto-post limit needs `BOOKKEEPING_ANOMALY_LOG_PATH` isolation, or `npm test` will append real entries to `memory/anomaly_log.json`** — check `git status` after running tests locally before committing.

### Config

`config/policies.yaml` is the single source of truth for `auto_post_limit` (env var wins if set). `config/settings.yaml` is human-facing metadata only — the actual `pi` harness config is `.pi/settings.json`.
