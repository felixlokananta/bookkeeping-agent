# Categorization Extension

**Status:** Implemented (Issue #4)

Auto-assigns categories (real Expenses/Income accounts) to transactions currently sitting in `Expenses:Uncategorized` / `Income:Uncategorized` using payee-pattern rules learned from past corrections, with an explicit fallback path for the agent to classify new/ambiguous payees and a bulk-recategorize tool for reviewing a batch conversationally.

## Overview

The categorization extension provides three tools:

1. **`list_uncategorized`** — Discover uncategorized transactions (optionally filtered by kind: expense/income).
2. **`suggest_category`** — Look up a learned rule for a transaction; if a rule matches, return high/low confidence with explanation; otherwise, no match (agent must reason).
3. **`apply_category`** — Categorize a single transaction or bulk-categorize a filtered batch (payee substring + optional amount ceiling). Persists learned rules to `memory/vendor_rules.json`.

## Rule Storage and Format

Rules are stored in `memory/vendor_rules.json` as a JSON object:

```json
{
  "normalized_payee_pattern": {
    "accountName": "Expenses:Office Supplies",
    "confidence": "high",
    "hits": 2,
    "lastAppliedAt": "2025-07-01T12:34:56.789Z"
  }
}
```

**Key properties:**
- **Pattern**: Normalized payee substring (lowercase, punctuation stripped, whitespace collapsed). Rules are keyed by this pattern in `vendor_rules.json`.
- **accountName**: The real category account (e.g., `"Expenses:Office Supplies"`).
- **confidence**: `"high"` (≥2 hits) or `"low"` (1 hit). Signals how reliable the rule is.
- **hits**: Number of times this rule has been applied (auto-incremented on each matching categorization).
- **lastAppliedAt**: ISO timestamp of the most recent application.

**Rule matching** is normalized-substring matching: if the normalized transaction payee contains the normalized rule pattern, it's a match. The longest (most specific) matching pattern is preferred.

## Design Decisions

1. **Re-categorization = direct in-place update.** No separate `category` column exists — "categorizing" means updating a split's `account_id` away from `Expenses:Uncategorized`/`Income:Uncategorized` to a real leaf account. This is an exception to the append-only hard rule, documented in `AGENTS.md` Hard Rule 7.

2. **Rules live in `memory/vendor_rules.json`** (path overridable via `BOOKKEEPING_VENDOR_RULES_PATH` env var for test isolation), consistent with the `anomaly_log.json` pattern.

3. **Post-hoc only.** Ingestion (`bank_sync/ingestion.ts`) and receipt OCR (`receipt_ocr/capture.ts`) are unchanged. New tools operate over already-posted Uncategorized splits.

4. **Agent-assisted fallback:** If no rule matches, `suggest_category` returns `{ matched: false }`, prompting the agent to reason over the transaction context (amount, payee, date, memo) itself — no in-tool LLM inference.

## Tools

### `list_uncategorized`

**Parameters:**
- `kind` (optional): `"expense"` or `"income"` — filter by transaction kind.
- `limit` (optional, default 100): Max transactions to return.

**Returns:**
- A list of uncategorized transactions with date, description, amount, and which Uncategorized account they're in.

**Example:**
```
User: "Show me the uncategorized expenses."
Agent: list_uncategorized { kind: "expense" }
Response:
  [
    { transactionId: 42, date: "2025-07-01", description: "AMAZON.COM 123456", amount: -2999, accountName: "Expenses:Uncategorized" },
    ...
  ]
```

### `suggest_category`

**Parameters:**
- `transactionId`: The transaction ID to look up.

**Returns:**
- If a rule matches: `{ matched: true, accountName: "...", confidence: "high"|"low", explanation: "..." }`
- If no rule matches: `{ matched: false }` — agent should reason and call `apply_category`.

**Example:**
```
Agent: suggest_category { transactionId: 42 }
Response:
  {
    matched: true,
    accountName: "Expenses:Office Supplies",
    confidence: "high",
    explanation: "Matched pattern \"amazon\" (4 hits)"
  }
```

### `apply_category`

**Parameters:**
- `transactionId` (optional): Single transaction ID to categorize.
- `filter` (optional): Bulk-categorize filter object:
  - `payeeContains` (optional): Substring match on transaction description.
  - `maxAmountMinor` (optional): Only apply to splits with abs(amount) ≤ maxAmountMinor (in cents).
  - `kind` (optional): `"expense"` or `"income"`.
- `accountName`: Target category account (colon-path, e.g., `"Expenses:Office Supplies"`). Auto-created if it doesn't exist.
- `force` (optional): Not used; present for consistency.

**Returns:**
- Single categorization: `{ transactionId, splitId, newAccountName, ruleRecorded: boolean }`
- Bulk categorization: `{ updated: number, transactionIds: number[] }`

**Single categorization example:**
```
User: "That Amazon charge is Office Supplies."
Agent: apply_category { transactionId: 42, accountName: "Expenses:Office Supplies" }
Response:
  {
    transactionId: 42,
    splitId: 123,
    newAccountName: "Expenses:Office Supplies",
    ruleRecorded: true
  }
```

**Bulk categorization example:**
```
User: "Categorize all Amazon charges under $20 as Office Supplies."
Agent: apply_category {
  filter: { payeeContains: "AMAZON", maxAmountMinor: 2000 },
  accountName: "Expenses:Office Supplies"
}
Response:
  { updated: 3, transactionIds: [42, 45, 47] }
```

## Rule Learning and Correction

- **First categorization**: When `apply_category` is called on a transaction, a new rule is created with `confidence: "low"` and `hits: 1`.
- **Subsequent matches**: Each time a transaction with a matching payee is categorized, the rule's `hits` increments and `confidence` escalates to `"high"` once `hits >= 2`.
- **Correction (re-categorization)**: If a rule's target account is corrected (e.g., a rule previously pointing to Office Supplies is now pointed at Supplies), the rule is overwritten with `hits: 1` and `confidence: "low"` (last-write-wins).

## Implementation Files

- **`rules.ts`**: Rule schema, normalization, matching, load/save.
- **`categorize.ts`**: Core functions (`listUncategorized`, `suggestCategory`, `applyCategory`, `bulkRecategorize`).
- **`index.ts`**: Pi extension adapter; registers the three tools.
- **`package.json`**: Extension manifest.
- **`tsconfig.json`**: TypeScript configuration.

## Risks and Gotchas

- **Two SQLite connections (WAL-safe):** The categorization extension opens its own ledger handle, same as `bank_sync` and `receipt_ocr`. This is a known-safe pattern under WAL mode.
- **In-place mutation is a narrow exception:** Direct `account_id` updates are only applied to `Expenses:Uncategorized`/`Income:Uncategorized` splits, never to `amount`/`date`/`description`. This is documented in `AGENTS.md` Hard Rule 7.
- **No fuzzy matching:** Rule matching is hand-rolled normalized-substring matching. Typo-tolerant fuzzy matching is out of scope.
- **Unbounded rule storage:** `vendor_rules.json` has no size cap; acceptable for v1 in a single-user, single-repo scope.

## Environment Variables

- **`BOOKKEEPING_VENDOR_RULES_PATH`** (optional): Override the default path (`memory/vendor_rules.json`) where rules are stored. Useful for test isolation.
- **`BOOKKEEPING_DB_PATH`** (optional): Path to the SQLite database (same as other extensions).
- **`NODE_ENV`** (optional): If set to `"test"`, the extension uses an in-memory ledger (`:memory:`).
