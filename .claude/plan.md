# Plan: Ledger foundation + repo scaffold — SQLite double-entry core, AGENTS.md, and project skeleton

## Source
GitHub issue #1: https://github.com/felixlokananta/bookkeeping-agent/issues/1
"Ledger foundation — SQLite schema and double-entry core" (enhancement). Issue 1 of 5; all other issues depend on it.
Revision history:
- Rev 1/2: pi must be a repo-local dependency invoked via `npx pi` (not a global CLI); all pi state lives inside this repo; extensions live under `.pi/extensions/<name>/index.ts` (pi's real auto-discovery convention).
- Rev 3 (this revision): also establish the overall repo scaffold for the agent project, anchored by an `AGENTS.md` at the repo root, adapted from a user-provided example tree. The example uses a bare top-level `extensions/` folder and `.py` files; this plan adapts that structure to pi's real conventions (TypeScript extensions under `.pi/extensions/`, not Python, not a bare `extensions/`). Only issue #1 (the ledger foundation) is fully implemented in this pass; the rest of the tree is a documented skeleton so later issues (#2-#5+) have a home.

## Summary
Build a SQLite-backed double-entry ledger for the bookkeeping agent, expose its core operations as `pi` agent tools, and lay down the whole-project scaffold around it. The ledger enforces the double-entry invariant (debits == credits) at write time, seeds a standard 5-type chart of accounts with nested sub-account support, and provides `list_accounts` / `create_account` / `post_transaction` / `get_balance` / `list_transactions` tools callable from a `pi` chat session. This revision adds the agent's identity/rules layer (`AGENTS.md`), a domain-knowledge file (`BRAIN.md`), a `config/` layer (`settings.yaml`, `policies.yaml`), and empty-but-documented `workflows/`, `memory/`, `data/`, and `scripts/` directories. Crucially, one of AGENTS.md's hard rules — never auto-post a transaction above a configurable dollar threshold without approval — is enforced in code by `post_transaction`, not left as prose.

## Goal
From a `pi` chat session started with `npx pi` in this repo (no globally installed pi required) an operator can: seed the default chart of accounts, create nested sub-accounts, post a balanced transaction, have an unbalanced transaction rejected, have an above-threshold transaction blocked pending approval (and logged to the anomaly log), and immediately query the correct resulting account balance — all through registered `pi` tools backed by a persistent SQLite database. The repo also contains a coherent, documented scaffold (AGENTS.md, BRAIN.md, config/, workflows/, memory/, data/, scripts/) that later issues extend without restructuring.

## Repository layout (target tree)
This adapts the user's example tree to pi's real conventions. `[functional]` = implemented and exercised in this pass; `[skeleton]` = created as an empty dir / stub doc so later issues have a home, with no working code yet.

```
bookkeeping-agent/
├── AGENTS.md                       # [functional] agent identity, tone, hard rules; names the 5 ledger tools
├── BRAIN.md                        # [functional] chart of accounts, normal-balance rules, fiscal year, currency
├── README.md                       # [functional] repo-local pi usage, tool list, smoke test (modify existing empty file)
├── package.json                    # [functional] root project; pins pi + yaml; npm scripts
├── package-lock.json               # [functional] committed lockfile (generated)
├── .gitignore                      # [functional]
│
├── config/
│   ├── settings.yaml               # [functional] human-facing project settings (db path, currency, model note); points at .pi/settings.json for real pi harness config
│   └── policies.yaml               # [functional] auto-post approval threshold + escalation notes; read by the ledger extension
│
├── workflows/
│   └── setup_ledger.md             # [functional] seed workflow doc: initialize DB + chart of accounts + first balanced entry (others deferred)
│
├── memory/
│   ├── anomaly_log.json            # [functional] append-only log of blocked/flagged transactions (seeded as [])
│   ├── vendor_rules.json           # [skeleton] placeholder {} for issue #4 categorization
│   └── session_logs/               # [skeleton] .gitkeep; future session transcripts
│
├── data/
│   ├── bookkeeping.db              # [functional, git-ignored] created at runtime
│   ├── inbox/                      # [skeleton] .gitkeep; raw statements/receipts (issue #2/#3)
│   ├── processed/                  # [skeleton] .gitkeep
│   └── exports/                    # [skeleton] .gitkeep (issue #5 reporting)
│
├── scripts/
│   └── run_agent.sh                # [functional] wrapper that runs the repo-local pi via `npx pi`
│
└── .pi/                            # pi's real project-local home (replaces the example's bare `extensions/`)
    ├── settings.json               # [functional, optional] repo-local pi settings; no ~/.pi dependency
    └── extensions/
        ├── bookkeeping/            # [functional] THE issue #1 deliverable
        │   ├── EXTENSION.md        # [functional] what this extension is + the 5 tools
        │   ├── package.json        # extension manifest (pi.extensions entry)
        │   ├── tsconfig.json       # editor type-check only
        │   ├── index.ts            # pi adapter: registers the 5 tools
        │   ├── ledger.ts           # pi-agnostic double-entry core (node:sqlite)
        │   ├── schema.ts           # DDL + default chart + constants
        │   ├── money.ts            # major<->minor unit helpers
        │   └── policy.ts           # loads the auto-post threshold from config/policies.yaml + anomaly logging
        ├── bank_sync/EXTENSION.md          # [skeleton] issue #2 home (doc stub only, no index.ts -> not auto-loaded)
        ├── categorization/EXTENSION.md     # [skeleton] issue #4
        ├── reconciliation/EXTENSION.md     # [skeleton] future
        ├── invoicing/EXTENSION.md          # [skeleton] future
        ├── receipt_ocr/EXTENSION.md        # [skeleton] issue #3
        └── reporting/EXTENSION.md          # [skeleton] issue #5

└── test/
    └── ledger.test.ts              # [functional] node:test unit tests for ledger core + policy gate
```

Reconciliation notes vs. the user's example:
- Example `extensions/<name>/<name>.py` -> pi requires TypeScript modules auto-discovered under `.pi/extensions/<name>/index.ts`. We keep the example's per-extension `EXTENSION.md` doc convention but place everything under `.pi/extensions/`. A skeleton extension dir that contains only `EXTENSION.md` (no `index.ts`/`package.json`) is NOT auto-loaded by pi, so the placeholders are inert and safe.
- Example `config/settings.yaml` "pi agent harness config" -> pi's actual machine-read config is `.pi/settings.json`. We keep `config/settings.yaml` as human-facing project settings and make it explicitly point to `.pi/settings.json` for the real harness config, to avoid two competing sources of truth.

## Context and key decisions
This repo currently contains only an empty `README.md` (plus `.idea/`, `.claude/`). The product is built on the `pi` coding agent (`@earendil-works/pi-coding-agent`). "pi agent tools" means custom tools registered in a **pi extension** (a TypeScript module exporting a default factory that receives `ExtensionAPI` and calls `pi.registerTool(...)`), auto-discovered from `.pi/extensions/<name>/index.ts`.

Decisions baked into this plan (flagged so a reviewer can veto before implementation):
1. **Language/runtime: TypeScript on Node 24 via pi's jiti loader.** No compile step; pi loads `.ts` directly.
2. **pi is a repo-local dependency, not a global CLI.** Root `package.json` pins `@earendil-works/pi-coding-agent` at exact `0.80.2` (verified in this environment; bump deliberately, never caret/`latest`). Run only via `npx pi` / `npm run pi` / `scripts/run_agent.sh`. Lockfile committed.
3. **All pi state is repo-local.** Extensions under `.pi/extensions/...`; any pi settings in repo-local `.pi/settings.json`. No `~/.pi` dependency.
4. **SQLite driver: Node built-in `node:sqlite` (`DatabaseSync`).** Zero external DB deps, synchronous (safe under pi's parallel tool execution). Emits an `ExperimentalWarning`; isolated behind `ledger.ts`.
5. **Money: integer minor units (cents), single currency (v1).** Tools accept major-unit numbers and round to integer minor units at the boundary; core operates purely in integers. Multi-currency out of scope.
6. **Double-entry representation: one `splits` row per leg, signed integer `amount`** (positive = debit, negative = credit). Balanced iff `SUM(amount) = 0`. Balance = `SUM(amount)` interpreted against the account's normal balance.
7. **Core logic is pi-agnostic and unit-testable.** `ledger.ts`/`money.ts`/`policy.ts` have no `pi` imports; `index.ts` is the thin adapter.
8. **DB location: `${BOOKKEEPING_DB_PATH}` override, default `<cwd>/data/bookkeeping.db`.** Git-ignored.
9. **NEW — AGENTS.md hard rule is code-enforced, not deferred.** DECISION: the "never auto-post above a configurable dollar threshold without approval" rule is enforced *now* by `post_transaction`, not deferred to a later issue. Rationale: a hard rule stated in AGENTS.md but not enforced by the tool is only advisory (the LLM could ignore it); enforcing it at the tool boundary is small, self-contained, and makes issue #1's foundation actually safe. Implementation is intentionally minimal: a single threshold read from `config/policies.yaml`, an `approved` boolean param on `post_transaction`, a reject-and-log path, and an append to `memory/anomaly_log.json`. Escalation UX, multi-tier limits, and per-account limits are deferred.
10. **NEW — config parsing dependency: `yaml`.** To keep `config/policies.yaml` the single source of truth for the threshold (rather than duplicating it into an env var), add the well-established `yaml` package (exact pin) as a runtime dependency, read only at ledger open. An env override `BOOKKEEPING_AUTOPOST_LIMIT` still wins for tests/CI. This is the only new runtime dep beyond pi itself.

## Affected files
Create unless noted.
- `package.json` (root) — project manifest; `dependencies`: `@earendil-works/pi-coding-agent` (exact `0.80.2`) and `yaml` (exact pin, e.g. `2.x` resolved at install). Scripts: `pi` (-> `pi`), `agent` (-> `bash scripts/run_agent.sh`), `test` (-> `node --test test/`). `"type": "module"`, `"private": true`.
- `package-lock.json` (generated by `npm install`, committed) — deterministic resolution.
- `.gitignore` — `data/*.db`, `*.db-wal`, `*.db-shm`, `node_modules/`, `memory/session_logs/*` (keep dir).
- `AGENTS.md` (root) — agent identity, tone, hard rules; enumerates the 5 ledger tools; states the auto-post threshold rule and points at `config/policies.yaml`.
- `BRAIN.md` (root) — chart-of-accounts model, the 5 account types + normal balances, colon-path sub-account convention, fiscal year, base currency, 2-decimal precision.
- `README.md` (modify existing empty file) — repo-local install, `npx pi` usage, tool list, smoke test, unit tests, pointer to AGENTS.md/BRAIN.md.
- `config/settings.yaml` — human-facing project settings (default db path, base currency, model preference note); explicit pointer to `.pi/settings.json` as the real pi harness config.
- `config/policies.yaml` — `auto_post_limit` (major units), `currency`, and escalation notes; consumed by `policy.ts`.
- `workflows/setup_ledger.md` — seed workflow: initialize DB, verify default chart, create first sub-accounts, post first balanced entry, verify balance.
- `memory/anomaly_log.json` — seeded `[]`; appended to when a post is blocked/flagged.
- `memory/vendor_rules.json` — seeded `{}` placeholder (issue #4).
- `memory/session_logs/.gitkeep` — keep empty dir.
- `data/inbox/.gitkeep`, `data/processed/.gitkeep`, `data/exports/.gitkeep` — keep empty dirs.
- `scripts/run_agent.sh` — `#!/usr/bin/env bash`, `set -euo pipefail`, `exec npx pi "$@"` (with a note that it must be run from the repo root); `chmod +x`.
- `.pi/settings.json` (optional) — repo-local pi settings; documents extension path / project-trust so no global config is needed.
- `.pi/extensions/bookkeeping/EXTENSION.md` — describes the extension and its 5 tools + the threshold behavior.
- `.pi/extensions/bookkeeping/package.json` — `{ "name": "bookkeeping", "type": "module", "pi": { "extensions": ["./index.ts"] } }`.
- `.pi/extensions/bookkeeping/tsconfig.json` — editor/type-check only (`nodenext`).
- `.pi/extensions/bookkeeping/index.ts` — pi adapter; registers the 5 tools.
- `.pi/extensions/bookkeeping/ledger.ts` — pi-agnostic double-entry core (`node:sqlite`).
- `.pi/extensions/bookkeeping/schema.ts` — DDL, default chart, `ACCOUNT_TYPES`, normal-balance map.
- `.pi/extensions/bookkeeping/money.ts` — major<->minor helpers + `formatMoney`.
- `.pi/extensions/bookkeeping/policy.ts` — loads `auto_post_limit` from `config/policies.yaml` (env override), exposes `checkAutoPost(magnitudeMinor)` and `logAnomaly(entry)` writing to `memory/anomaly_log.json`.
- `.pi/extensions/{bank_sync,categorization,reconciliation,invoicing,receipt_ocr,reporting}/EXTENSION.md` — skeleton stubs naming the owning future issue; no code, not auto-loaded.
- `test/ledger.test.ts` — `node:test` unit tests for ledger core, money helpers, and the policy gate.

## Data model

### Table: accounts
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `name` TEXT NOT NULL — full colon path, e.g. `Assets:Checking`, `Expenses:Food:Groceries`
- `type` TEXT NOT NULL — CHECK IN (`asset`,`liability`,`equity`,`income`,`expense`)
- `parent_id` INTEGER NULL REFERENCES accounts(id)
- `normal_balance` TEXT NOT NULL — `debit` for asset/expense, `credit` for liability/equity/income (derived from `type`)
- `created_at` INTEGER NOT NULL — epoch ms
- UNIQUE(`name`)

### Table: transactions
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `date` TEXT NOT NULL — ISO `YYYY-MM-DD`
- `description` TEXT NULL
- `created_at` INTEGER NOT NULL — epoch ms

### Table: splits (journal entries)
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `transaction_id` INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE
- `account_id` INTEGER NOT NULL REFERENCES accounts(id)
- `amount` INTEGER NOT NULL — signed minor units (debit positive, credit negative)
- `memo` TEXT NULL

Indexes: `idx_splits_account` on `splits(account_id)`, `idx_splits_txn` on `splits(transaction_id)`, `idx_txn_date` on `transactions(date)`.
PRAGMAs on open: `journal_mode = WAL`, `foreign_keys = ON`.

Normal-balance convention: raw balance = `SUM(splits.amount)`. Debit-normal account natural balance = raw; credit-normal natural balance = `-1 * raw`, so liability/equity/income show a positive natural balance when carrying the expected credit balance.

## Implementation steps

### Step 1: Repo scaffold, AGENTS.md, and config
**Files:** `AGENTS.md`, `BRAIN.md`, `config/settings.yaml`, `config/policies.yaml`, `workflows/setup_ledger.md`, `memory/anomaly_log.json`, `memory/vendor_rules.json`, `memory/session_logs/.gitkeep`, `data/{inbox,processed,exports}/.gitkeep`, `scripts/run_agent.sh`, and skeleton `.pi/extensions/*/EXTENSION.md` stubs.
**What:** Lay down the whole-project skeleton described in the target tree.
**Why:** Gives the agent an identity/rules layer and gives future issues (#2-#5+) a home without restructuring; makes the AGENTS.md hard rules concrete and pointed at real config.
**Details:**
- `AGENTS.md` — sections: **Identity** (a cautious bookkeeping assistant that maintains a double-entry ledger); **Tone** (precise, terse, numeric; never guesses account codes); **Hard rules**:
  1. Never auto-post a transaction whose size (total debits) exceeds the `auto_post_limit` in `config/policies.yaml` without explicit human approval; such posts must be blocked and recorded in `memory/anomaly_log.json`.
  2. Every transaction's split amounts must sum to zero — never fabricate a balancing figure to force a post; surface the mismatch instead.
  3. Always flag anomalies/mismatches (imbalance, unknown account, above-threshold) rather than silently proceeding.
  4. Never edit or delete posted transactions (append-only ledger in v1).
  **Tools this agent has (issue #1):** `list_accounts`, `create_account`, `post_transaction`, `get_balance`, `list_transactions` — each described in one line, with the note that `post_transaction` enforces rules 1-2 in code.
- `BRAIN.md` — the domain knowledge the ledger relies on: the 5 account types and their normal balances; the colon-path sub-account convention; the default chart (5 roots); base currency + 2-decimal precision; fiscal year (calendar year, documented as configurable later). Kept scoped to what issue #1 needs; explicitly marks vendor->category and tax rules as "TBD in later issues".
- `config/settings.yaml` — `db_path: data/bookkeeping.db`, `currency: USD`, `model: <note that pi model/harness config is set in .pi/settings.json>`. A header comment states this file is human-facing and `.pi/settings.json` is the machine-read pi config.
- `config/policies.yaml` — `auto_post_limit: 500.00` (major units), `currency: USD`, plus commented escalation notes (who approves, deferred). This is the single source of truth for the threshold.
- `workflows/setup_ledger.md` — a short runnable-by-a-human checklist / prompt sequence to bring a fresh clone to a working ledger (install, run pi, seed, first entry, verify balance). Other workflow docs (monthly_close, reconcile_bank, categorize_batch) are intentionally NOT created — deferred.
- `memory/anomaly_log.json` seeded `[]`; `memory/vendor_rules.json` seeded `{}`.
- `scripts/run_agent.sh` — repo-local pi launcher (`exec npx pi "$@"`), executable.
- Skeleton `EXTENSION.md` stubs each state: owning issue, that the extension is not yet implemented, and that it must be a TypeScript `index.ts` under this dir when built. No `index.ts`/`package.json` in skeleton dirs, so pi will not auto-load them.

### Step 2: Schema and seed constants
**File:** `.pi/extensions/bookkeeping/schema.ts`
**What:** Export `ACCOUNT_TYPES` (5 type strings), `NORMAL_BALANCE_BY_TYPE`, `SCHEMA_SQL` (CREATE TABLE IF NOT EXISTS + indexes + pragmas), and `DEFAULT_CHART` (roots: `Assets`/asset, `Liabilities`/liability, `Equity`/equity, `Income`/income, `Expenses`/expense).
**Why:** Central, testable DDL + default chart so init and tests stay in sync; consistent with BRAIN.md.
**Details:** `NORMAL_BALANCE_BY_TYPE = { asset:'debit', expense:'debit', liability:'credit', equity:'credit', income:'credit' }`. Root names are human-readable plurals; `type` is the singular enum. DDL idempotent so `initLedger` is safe every startup.

### Step 3: Money helpers
**File:** `.pi/extensions/bookkeeping/money.ts`
**What:** `toMinor(major: number): number` (round `major*100`), `toMajor(minor: number): number`, `formatMoney(minor: number): string` (e.g. `-12.50`). Pure, no I/O.
**Why:** Single audited float->int boundary; used by tools, policy checks, and tests.
**Details:** `toMinor` uses `Math.round`, throws on `NaN`/non-finite. Document 2-decimal precision.

### Step 4: Policy loader and anomaly log
**File:** `.pi/extensions/bookkeeping/policy.ts`
**What:** Load the auto-post threshold and provide the enforcement + logging helpers used by `post_transaction`.
**Why:** Makes AGENTS.md hard rule #1 code-enforced and keeps `config/policies.yaml` the source of truth.
**Details — exported API:**
- `loadAutoPostLimitMinor(): number` — resolution order: env `BOOKKEEPING_AUTOPOST_LIMIT` (major units) -> `auto_post_limit` in `config/policies.yaml` (parsed with `yaml`) -> default `500.00`; convert to minor units via `toMinor`. Resolve the policies path relative to repo root (cwd), tolerate a missing file by falling back to default (and note it).
- `checkAutoPost(magnitudeMinor: number, opts: { approved?: boolean }): { allowed: boolean; limitMinor: number }` — allowed iff `approved === true` OR `magnitudeMinor <= limit`.
- `logAnomaly(entry): void` — append a structured record `{ ts, kind, detail, magnitudeMinor?, limitMinor? }` to `memory/anomaly_log.json` (read-modify-write JSON array; create/repair to `[]` if malformed). `kind` in (`above_threshold`, `imbalanced`, `unknown_account`).
**Edge cases:** unreadable/missing policies.yaml -> default limit, no throw; env override always wins; `:memory:`/test mode still reads the real config unless env override is set.

### Step 5: Ledger core (pi-agnostic)
**File:** `.pi/extensions/bookkeeping/ledger.ts`
**What:** Double-entry engine over `node:sqlite`. No `pi` imports.
**Why:** Isolates correctness-critical logic; unit-testable; reusable by later issues.
**Details — exported API (amounts in integer minor units):**
- `openLedger(dbPath?): Ledger` — resolve path (env `BOOKKEEPING_DB_PATH` -> arg -> `<cwd>/data/bookkeeping.db`, or `:memory:` for tests), `mkdir -p` parent, open `DatabaseSync`, apply pragmas, run `SCHEMA_SQL`, seed roots. Idempotent. Returns handle + prepared statements.
- `seedDefaultChart(db)` — insert each root only if absent (`INSERT OR IGNORE` on UNIQUE(name)).
- `createAccount(l, { name, type?, parent? }): Account` — nested paths: derive parent from colon prefix, auto-create missing ancestors, inherit `type` from root; explicit `type` must match root or throw; unknown root without `type` throws; duplicate name throws.
- `postTransaction(l, { date, description?, splits, approved? }): { transactionId, splitIds }` — VALIDATION (throw + `logAnomaly`, write nothing): >=2 splits; every account resolves; every amount is a non-zero integer; `SUM(amount) === 0` (imbalance -> `logAnomaly('imbalanced')`); **threshold gate** via `checkAutoPost(sumOfDebits, { approved })` — if not allowed, `logAnomaly('above_threshold')` and throw an approval-required error naming the limit. On success, wrap transaction + split INSERTs in `BEGIN IMMEDIATE ... COMMIT` (rollback on error). Accept `account` by name or id. `magnitude = sum of positive split amounts` (== total debits).
- `getBalance(l, { account, asOf?, includeChildren? }): { accountId, name, type, normalBalance, rawMinor, naturalMinor }` — `SUM(amount)` over splits joined to transactions, `date <= asOf` when given; `naturalMinor = normalBalance==='debit' ? rawMinor : -rawMinor`; `includeChildren` defaults false (v1 exact account).
- `listAccounts(l): Account[]` — all accounts ordered by `name`.
- `listTransactions(l, { account?, startDate?, endDate?, limit? }): TransactionWithSplits[]` — join + filters; order by `date`,`id`; default `limit` 100.
- `resolveAccount(l, ref): Account` — throws `Account not found: <ref>`.
- `closeLedger(l)`.
**Edge cases:** unbalanced rejected + logged; unknown account rejected + logged; zero-amount split rejected; single-split rejected; duplicate account rejected; above-threshold blocked + logged; empty description allowed; `YYYY-MM-DD` validated.

### Step 6: pi extension adapter and tools
**File:** `.pi/extensions/bookkeeping/index.ts`
**What:** `export default function(pi: ExtensionAPI)` opening the ledger once (on `session_start`) and registering five tools with `typebox` schemas. Each tool converts major->minor at the boundary, calls the matching `ledger.ts` function, returns `{ content: [{ type:'text', text }], details }`. Throw inside `execute` to surface errors (sets `isError`).
**Why:** Exposes the ledger to the LLM/harness per acceptance criteria.
**Details — tools:**
- `list_accounts` — no params. Returns chart (name, type, normal balance).
- `create_account` — `name: string` (colon path), `type?: StringEnum(ACCOUNT_TYPES)`. Returns created account.
- `post_transaction` — `date: string (YYYY-MM-DD)`, `description?: string`, `approved?: boolean` (default false), `splits: Array<{ account: string, amount: number (major, +debit/-credit), memo?: string }>`. Converts each `amount` via `toMinor`, calls `postTransaction`. Returns transaction id + formatted summary. Imbalance AND above-threshold surface as thrown errors; the `promptGuidelines` explain that above-threshold posts require the operator to confirm and re-call with `approved: true`, per AGENTS.md hard rule #1.
- `get_balance` — `account: string`, `asOf?: string`, `includeChildren?: boolean`. Returns natural balance via `formatMoney` + raw fields in `details`.
- `list_transactions` — `account?: string`, `start_date?: string`, `end_date?: string`, `limit?: number`. Compact table in `content`, structured rows in `details`.
Use `StringEnum` from `@earendil-works/pi-ai` for the type enum. Add per-tool `promptSnippet`/`promptGuidelines` naming each tool and restating the sum-to-zero and threshold rules so tool guidance is consistent with AGENTS.md. Open ledger in `session_start`, close in `session_shutdown`; guard `:memory:` vs file. Normalize a leading `@` on path-like string args.

### Step 7: Project packaging and pi dependency
**Files:** `package.json` (root), `.pi/extensions/bookkeeping/package.json`, `.pi/extensions/bookkeeping/tsconfig.json`, `.pi/settings.json` (optional), `.gitignore`
**What:**
- Root `package.json`: `"name":"bookkeeping-agent"`, `"private":true`, `"type":"module"`; `dependencies` pin `@earendil-works/pi-coding-agent` at `0.80.2` and `yaml` (exact resolved pin); `scripts`: `"pi":"pi"`, `"agent":"bash scripts/run_agent.sh"`, `"test":"node --test test/"`. Run `npm install` to generate + commit `package-lock.json`.
- Extension `package.json`: `{ "name":"bookkeeping", "type":"module", "pi": { "extensions":["./index.ts"] } }`.
- `tsconfig.json`: `nodenext`, editor type-check only; no build.
- `.pi/settings.json` (optional): repo-local settings; document extension path + project-trust so no `~/.pi` needed.
- `.gitignore`: `data/*.db`, `*.db-wal`, `*.db-shm`, `node_modules/`, `memory/session_logs/*` (but keep `.gitkeep`).
**Why:** Reproducible repo-local pi (no global), auto-discoverable extension, all state in-repo.
**Details:** `typebox`/`@earendil-works/pi-ai` are provided by the pi runtime; `import type` erased at load. `yaml` is the only added first-party runtime dep. Project-local `.pi/extensions` load only after the project is trusted (first-run trust prompt) — document.

### Step 8: Tests
**File:** `test/ledger.test.ts`
**What:** `node:test` + `node:assert` suite against an in-memory DB (`openLedger(':memory:')`), with `BOOKKEEPING_AUTOPOST_LIMIT` set per-test to exercise the gate deterministically.
**Why:** Locks in double-entry invariant, balance correctness, and the threshold gate without a live pi session.
**Details:** see "Tests to write".

### Step 9: README (repo-local pi usage)
**File:** `README.md` (modify)
**What:** Document the self-contained workflow: prerequisites (Node 24+, do NOT install pi globally); install (`npm install`); run (`npx pi` / `npm run pi` / `scripts/run_agent.sh`); first-run trust prompt + auto DB init; the five tools with example prompts; the smoke test; unit tests; and pointers to `AGENTS.md`/`BRAIN.md`/`workflows/setup_ledger.md`.
**Smoke test:** `npx pi -p "list all accounts, then post a $100 owner investment (debit Assets:Checking, credit Equity:Owner) dated today, then show the Assets:Checking balance"` returns a $100 Assets:Checking balance. Also document (a) the unbalanced-rejection prompt and (b) an above-threshold prompt (e.g. a $5,000 post with default $500 limit) that is blocked and appears in `memory/anomaly_log.json`, then succeeds when re-run with approval.

## Tests to write
- init seeds exactly the 5 roots with correct types/normal balances; `openLedger` twice does not duplicate roots.
- `createAccount('Assets:Checking')` creates a child under `Assets` inheriting `type=asset`, `normal_balance=debit`.
- `createAccount('Expenses:Food:Groceries')` auto-creates the `Expenses:Food` intermediate and links parents.
- duplicate account name throws; unknown-root-without-type throws.
- `postTransaction` with balanced splits succeeds and persists splits.
- `postTransaction` with unbalanced splits throws AND writes nothing (row counts unchanged) AND appends an `imbalanced` anomaly entry.
- `postTransaction` single split throws; unknown account throws; zero amount throws.
- **threshold gate:** with `BOOKKEEPING_AUTOPOST_LIMIT=100`, a balanced $500 post throws an approval-required error, writes nothing, and appends an `above_threshold` anomaly entry; the same post with `approved: true` succeeds and writes.
- **policy loader:** env override wins; missing/malformed policies.yaml falls back to default without throwing.
- post then `getBalance`: `Assets:Checking` positive natural balance; paired `Equity:Owner` positive natural balance; raw balances net to zero.
- `getBalance` with `asOf` excludes later-dated transactions.
- `listTransactions` filters by account and inclusive date range; respects `limit`.
- money helpers: `toMinor(12.5)===1250`; `0.1+0.2` rounds exact to cents; `formatMoney(-1250)==='-12.50'`.
- (manual) `npx pi` smoke test from README completes end-to-end with no global pi present, including the above-threshold block-then-approve path.

## Risks and gotchas
- **No global pi:** always `npx pi` / `npm run pi` / `scripts/run_agent.sh`; CI runs `npm ci` first so `npx pi` uses the locked version.
- **Pinned version drift:** `0.80.2` pinned exactly; bump deliberately with lockfile update, never caret/`latest`. Confirm `@earendil-works/pi-coding-agent` is the correct published package providing the `pi` binary before pinning.
- **`node:sqlite` experimental** — prints `ExperimentalWarning`; isolated behind `ledger.ts`.
- **Floating-point money:** integer minor units in core; floats only at the tool boundary, immediately rounded via `toMinor`; reject non-finite.
- **Parallel tool execution:** `DatabaseSync` is synchronous and writes use `BEGIN IMMEDIATE`; one shared `Ledger` per session serializes safely.
- **Anomaly log concurrency:** `logAnomaly` does read-modify-write on a JSON file; under pi's parallel tool calls two appends could race. For v1 volumes this is acceptable; note it and keep the writes small/synchronous. If it becomes a problem, move the anomaly log into a SQLite table (out of scope now).
- **Config source of truth:** the threshold lives in `config/policies.yaml`; `policy.ts` reads it (env override for tests). Ensure AGENTS.md, policies.yaml, and `post_transaction` all reference the same limit — do not hardcode a second copy.
- **Project trust:** project-local `.pi/extensions` load only after the project is trusted; first run shows a trust prompt — document so missing tools aren't mistaken for a bug.
- **Skeleton extensions must stay inert:** placeholder dirs contain only `EXTENSION.md` (no `index.ts`/`package.json`) so pi does not try to auto-load them.
- **DB file lifecycle:** WAL creates `-wal`/`-shm` sidecars; `.gitignore` covers them.
- **Foreign keys:** set `PRAGMA foreign_keys = ON` on every connection.

## Out of scope
Functional in this pass: `AGENTS.md`, `BRAIN.md`, `README.md`, root `package.json`/lockfile, `.gitignore`, `config/settings.yaml`, `config/policies.yaml`, `workflows/setup_ledger.md`, `memory/anomaly_log.json`, `scripts/run_agent.sh`, `.pi/settings.json`, and the entire `.pi/extensions/bookkeeping/` extension with its 5 tools (including the code-enforced auto-post threshold gate) and `test/ledger.test.ts`.

Skeleton only (created as empty dirs / stub docs, NOT implemented this pass):
- `.pi/extensions/bank_sync/` (issue #2), `receipt_ocr/` (issue #3), `categorization/` (issue #4), `reporting/` (issue #5), `reconciliation/`, `invoicing/` — each just an `EXTENSION.md` stub, not auto-loaded.
- `memory/vendor_rules.json` (placeholder `{}` for issue #4), `memory/session_logs/` (empty).
- `data/inbox/`, `data/processed/`, `data/exports/` (empty; ingestion/reporting later).
- Additional `workflows/` docs (monthly_close, reconcile_bank, categorize_batch) — not created.

Explicitly not done at all in issue #1:
- Ingestion / CSV / bank import (issue #2); receipt/invoice OCR (issue #3); categorization engine + vendor rules learning (issue #4); reporting + tax export (issue #5).
- Multi-currency/FX; rounding policies beyond single-currency 2-decimal minor units.
- Editing/deleting/reversing posted transactions; account archiving/renaming.
- Multi-tier / per-account approval limits, approval routing/escalation UX, and an approval audit trail beyond the single-threshold gate + anomaly log.
- Authentication, multi-user, remote/hosted DB backends.
