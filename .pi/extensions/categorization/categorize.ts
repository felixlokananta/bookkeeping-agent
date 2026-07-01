/**
 * Core categorization logic: pi-agnostic, unit-testable.
 * Handles listing uncategorized transactions, suggesting categories, and applying them.
 */

import type { Ledger } from '../bookkeeping/ledger.ts';
import { resolveAccount, createAccount } from '../bookkeeping/ledger.ts';
import type { Rules, Rule } from './rules.ts';
import {
  normalizePayee,
  matchRule,
  loadRules,
  saveRules,
  upsertRule,
  extractVendorPattern,
} from './rules.ts';

/**
 * List uncategorized transactions.
 * Returns transactions that have at least one split pointing to Expenses:Uncategorized or Income:Uncategorized.
 *
 * Options:
 * - kind: 'expense' | 'income' — filter by split kind
 * - limit: number — max transactions to return
 */
export interface ListUncategorizedOpts {
  kind?: 'expense' | 'income';
  limit?: number;
}

export interface UncategorizedTransaction {
  transactionId: number;
  date: string;
  description: string | null;
  amount: number; // The uncategorized split's amount (signed)
  accountId: number; // The Uncategorized account id
  accountName: string; // 'Expenses:Uncategorized' or 'Income:Uncategorized'
}

export function listUncategorized(
  ledger: Ledger,
  opts?: ListUncategorizedOpts
): UncategorizedTransaction[] {
  const { kind, limit = 100 } = opts || {};

  // Resolve Uncategorized account ids
  let expensesId: number | null = null;
  let incomeId: number | null = null;

  try {
    expensesId = resolveAccount(ledger, 'Expenses:Uncategorized').id;
  } catch {
    // Account doesn't exist yet
  }

  try {
    incomeId = resolveAccount(ledger, 'Income:Uncategorized').id;
  } catch {
    // Account doesn't exist yet
  }

  if (!expensesId && !incomeId) {
    // No uncategorized accounts exist
    return [];
  }

  // Build the SQL query
  const accountIds = [];
  const kindFilters = [];

  if (!kind || kind === 'expense') {
    if (expensesId) {
      accountIds.push(expensesId);
      kindFilters.push("'expense'");
    }
  }
  if (!kind || kind === 'income') {
    if (incomeId) {
      accountIds.push(incomeId);
      kindFilters.push("'income'");
    }
  }

  if (accountIds.length === 0) {
    return [];
  }

  const placeholders = accountIds.map(() => '?').join(',');
  const sql = `
    SELECT DISTINCT t.id, t.date, t.description, s.account_id, s.amount
    FROM transactions t
    JOIN splits s ON t.id = s.transaction_id
    WHERE s.account_id IN (${placeholders})
    ORDER BY t.date DESC, t.id DESC
    LIMIT ?
  `;

  const rows = ledger.db.prepare(sql).all(...accountIds, limit) as Array<{
    id: number;
    date: string;
    description: string | null;
    account_id: number;
    amount: number;
  }>;

  // Map to account names
  const accountNamesById: Record<number, string> = {};
  if (expensesId) accountNamesById[expensesId] = 'Expenses:Uncategorized';
  if (incomeId) accountNamesById[incomeId] = 'Income:Uncategorized';

  return rows.map((row) => ({
    transactionId: row.id,
    date: row.date,
    description: row.description,
    amount: row.amount,
    accountId: row.account_id,
    accountName: accountNamesById[row.account_id] || 'Unknown',
  }));
}

/**
 * Suggest a category for a payee/memo combination.
 * Matches against the rules; returns high/low confidence with explanation.
 * If no rule matches, returns { matched: false } for the calling agent to infer.
 */
export interface SuggestCategoryResult {
  matched: true;
  accountName: string;
  confidence: 'high' | 'low';
  explanation: string;
}

export interface NoSuggestCategoryResult {
  matched: false;
}

export function suggestCategory(
  payee: string,
  memo: string | null,
  rules: Rules
): SuggestCategoryResult | NoSuggestCategoryResult {
  // Try to match on payee first, then memo
  const combinedText = [payee, memo].filter(Boolean).join(' ');
  const match = matchRule(combinedText, rules);

  if (!match) {
    return { matched: false };
  }

  const { pattern, rule } = match;
  return {
    matched: true,
    accountName: rule.accountName,
    confidence: rule.confidence,
    explanation: `Matched pattern "${pattern}" (${rule.hits} hit${rule.hits === 1 ? '' : 's'})`,
  };
}

/**
 * Apply a category to a transaction.
 * Updates the transaction's categorizable split (the one posted against an
 * expense/income account — Uncategorized or, for a correction, an
 * already-assigned real category) to point at the target account. Optionally
 * upserts a rule into vendor_rules.json.
 *
 * "Categorizable" is identified by account type (expense/income), not by
 * name, so this same path handles both first-pass categorization (moving off
 * Uncategorized) and later corrections (moving off a previously-assigned
 * category) — a transaction never has more than one such split in the
 * ingestion patterns this extension targets (one expense/income leg, one
 * asset/liability source leg).
 *
 * Throws if:
 * - Transaction not found
 * - Transaction has no expense/income split to categorize
 * - Transaction has more than one expense/income split (ambiguous — a
 *   multi-way split transaction isn't supported by this tool)
 * - Target account cannot be resolved/created
 */
export interface ApplyCategoryOpts {
  recordRule?: boolean; // Default: true
}

export interface ApplyCategoryResult {
  transactionId: number;
  splitId: number;
  newAccountName: string;
  ruleRecorded: boolean;
}

export function applyCategory(
  ledger: Ledger,
  transactionId: number,
  accountRef: string,
  opts?: ApplyCategoryOpts
): ApplyCategoryResult {
  const { recordRule = true } = opts || {};

  // Fetch the transaction
  const txSql = `SELECT * FROM transactions WHERE id = ?`;
  const transaction = ledger.db.prepare(txSql).get(transactionId) as any;
  if (!transaction) {
    throw new Error(`Transaction ${transactionId} not found`);
  }

  // Find the categorizable split: the leg posted against an expense/income
  // account (whether that's currently Uncategorized, for first-pass
  // categorization, or a real category, for a correction).
  const splitSql = `
    SELECT s.id, s.account_id, s.amount, a.name, a.type
    FROM splits s
    JOIN accounts a ON s.account_id = a.id
    WHERE s.transaction_id = ? AND a.type IN ('expense', 'income')
  `;
  const candidateSplits = ledger.db.prepare(splitSql).all(transactionId) as any[];

  if (candidateSplits.length === 0) {
    throw new Error(`Transaction ${transactionId} has no expense/income split to categorize`);
  }
  if (candidateSplits.length > 1) {
    const ids = candidateSplits.map((s) => s.id).join(', ');
    throw new Error(
      `Transaction ${transactionId} has multiple expense/income splits (ids: ${ids}); ` +
        'ambiguous, not supported by apply_category'
    );
  }
  const categorizableSplit = candidateSplits[0];

  // Resolve or create the target account
  let targetAccount;
  try {
    targetAccount = resolveAccount(ledger, accountRef);
  } catch {
    // Account doesn't exist; create it
    // Infer type from the root account
    targetAccount = createAccount(ledger, { name: accountRef });
  }

  // Type safety check: ensure the target account type matches the categorizable split's type
  if (targetAccount.type !== categorizableSplit.type) {
    throw new Error(
      `Cannot categorize an ${categorizableSplit.type} split to account "${targetAccount.name}" of type '${targetAccount.type}'; target must be type '${categorizableSplit.type}'`
    );
  }

  // No-op guard: re-applying the same account shouldn't churn the rule store.
  if (categorizableSplit.account_id === targetAccount.id) {
    return {
      transactionId,
      splitId: categorizableSplit.id,
      newAccountName: targetAccount.name,
      ruleRecorded: false,
    };
  }

  // Update the split's account_id
  const updateSql = `UPDATE splits SET account_id = ? WHERE id = ?`;
  ledger.db.prepare(updateSql).run(targetAccount.id, categorizableSplit.id);

  // Optionally record/upsert a rule, keyed on a generalized vendor pattern
  // (not the raw description) so repeat charges from the same vendor
  // actually accumulate hits instead of each producing a distinct pattern.
  let ruleRecorded = false;
  if (recordRule) {
    const rules = loadRules();
    const payee = transaction.description || '';
    upsertRule(rules, extractVendorPattern(payee), targetAccount.name);
    saveRules(rules);
    ruleRecorded = true;
  }

  return {
    transactionId,
    splitId: categorizableSplit.id,
    newAccountName: targetAccount.name,
    ruleRecorded,
  };
}

/**
 * Bulk-recategorize transactions matching a filter.
 *
 * Filter options:
 * - payeeContains: substring match (case-insensitive) on transaction description
 * - maxAmountMinor: only apply to splits with abs(amount) <= maxAmountMinor
 * - kind: 'expense' | 'income'
 */
export interface BulkRecategorizeFilter {
  payeeContains?: string;
  maxAmountMinor?: number;
  kind?: 'expense' | 'income';
}

export interface BulkRecategorizeFailure {
  transactionId: number;
  error: string;
}

export interface BulkRecategorizeResult {
  updated: number;
  transactionIds: number[];
  failed: BulkRecategorizeFailure[];
}

export function bulkRecategorize(
  ledger: Ledger,
  filter: BulkRecategorizeFilter,
  accountRef: string,
  opts?: ApplyCategoryOpts
): BulkRecategorizeResult {
  // List uncategorized transactions matching the filter
  const uncategorized = listUncategorized(ledger, { kind: filter.kind, limit: 10000 });

  const updated: number[] = [];
  const failed: BulkRecategorizeFailure[] = [];

  for (const tx of uncategorized) {
    // Filter by payee substring
    if (filter.payeeContains) {
      const desc = tx.description || '';
      if (!desc.toLowerCase().includes(filter.payeeContains.toLowerCase())) {
        continue;
      }
    }

    // Filter by max amount (absolute value)
    if (filter.maxAmountMinor !== undefined) {
      if (Math.abs(tx.amount) > filter.maxAmountMinor) {
        continue;
      }
    }

    // Apply the category
    try {
      applyCategory(ledger, tx.transactionId, accountRef, opts);
      updated.push(tx.transactionId);
    } catch (err) {
      failed.push({
        transactionId: tx.transactionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    updated: updated.length,
    transactionIds: updated,
    failed,
  };
}
