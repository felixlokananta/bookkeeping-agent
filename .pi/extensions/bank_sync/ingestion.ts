/**
 * Ingestion posting core: pi-agnostic, unit-testable.
 * Shared by `log_transaction` and `import_csv` so both behave identically:
 * same duplicate check, same sign/offset-account inference (design decision
 * #1 in plan.md).
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 *
 * NOTE: This extension (#2 bank_sync) intentionally imports from #4
 * categorization (rules.ts) to enable auto-categorization at ingestion
 * time. This is an exception to the extension build order documented in
 * CLAUDE.md; see plan.md for details. No circular dependency exists.
 */

import {
  createAccount,
  postTransaction,
  resolveAccount,
  type Account,
  type Ledger,
} from '../bookkeeping/ledger.ts';
import { findLikelyDuplicates, type DuplicateMatch } from './dedupe.ts';
import { parseDate, parseAmountCents, type ColumnMap } from './csv.ts';
import { matchRule, loadRules, type Rules } from '../categorization/rules.ts';

export type UncategorizedKind = 'expense' | 'income';

const UNCATEGORIZED_NAME: Record<UncategorizedKind, string> = {
  expense: 'Expenses:Uncategorized',
  income: 'Income:Uncategorized',
};

/**
 * Resolve (or create on first use) the Expenses:Uncategorized /
 * Income:Uncategorized account. The Expenses/Income root accounts already
 * exist in DEFAULT_CHART, so createAccount's colon-path auto-parent-creation
 * is a no-op beyond creating the single Uncategorized leaf.
 */
export function ensureUncategorizedAccount(ledger: Ledger, kind: UncategorizedKind): Account {
  const name = UNCATEGORIZED_NAME[kind];
  try {
    return resolveAccount(ledger, name);
  } catch {
    return createAccount(ledger, { name });
  }
}

export interface ResolveCategoryForEntryOpts {
  payee: string;
  memo?: string | null;
  expectedKind: UncategorizedKind;
  rules: Rules;
}

/**
 * Attempt to resolve a matched high-confidence category for an ingested entry.
 * Returns the target Account if a high-confidence vendor rule matches the
 * payee+memo combination and the resolved account's type matches expectedKind.
 * Otherwise returns null, signaling the caller to fall back to Uncategorized.
 *
 * Never throws: a rule whose target account can't be resolved or created
 * (e.g. a hand-edited/stale vendor_rules.json entry) falls back to null
 * rather than crashing ingestion, matching this feature's fallback-first design.
 */
export function resolveCategoryForEntry(
  ledger: Ledger,
  opts: ResolveCategoryForEntryOpts
): Account | null {
  const { payee, memo, expectedKind, rules } = opts;

  // Mirror suggestCategory's join convention: combine payee and memo
  const combinedText = [payee, memo].filter(Boolean).join(' ');
  const match = matchRule(combinedText, rules);

  // No match or low confidence: fall back to Uncategorized
  if (!match || match.rule.confidence !== 'high') {
    return null;
  }

  // Resolve or create the matched account
  let targetAccount: Account;
  try {
    targetAccount = resolveAccount(ledger, match.rule.accountName);
  } catch {
    try {
      // Account doesn't exist; create it
      targetAccount = createAccount(ledger, { name: match.rule.accountName });
    } catch {
      // Can't create it either (e.g. root account missing, invalid name) — fall back
      return null;
    }
  }

  // Type-safety check: ensure the account's type matches the expected kind
  // (expense transaction should post against expense account, income against income)
  if (targetAccount.type !== expectedKind) {
    return null;
  }

  return targetAccount;
}

export interface PostIngestedEntryOptions {
  date: string;
  amountMinor: number;
  account: string | number;
  description: string | null | undefined;
  memo?: string;
  force?: boolean;
  approved?: boolean;
  windowDays?: number;
  rules?: Rules;
}

export type PostIngestedEntryResult =
  | { transactionId: number; splitIds: number[] }
  | { duplicate: DuplicateMatch };

/**
 * Post a single ingested entry as a balanced two-split transaction against
 * `account` and either a matched category account (if a high-confidence vendor
 * rule matches) or the inferred Uncategorized account. Sign convention matches
 * `post_transaction`: negative amountMinor = money out (expense, debits
 * matched category or Expenses:Uncategorized), positive = money in (income,
 * credits matched category or Income:Uncategorized).
 *
 * Runs findLikelyDuplicates first (skipped if `force`); if a duplicate is
 * found, returns { duplicate } instead of posting. Re-throws postTransaction
 * errors (imbalance/threshold) unchanged.
 *
 * If `rules` is not provided, loads fresh rules from disk; if provided, uses
 * the pre-loaded Rules object to avoid redundant file reads (useful when
 * posting many rows in importCsvRows).
 */
export function postIngestedEntry(
  ledger: Ledger,
  opts: PostIngestedEntryOptions
): PostIngestedEntryResult {
  const { date, amountMinor, account, description, memo, force, approved, windowDays, rules: rulesParam } = opts;

  if (!force) {
    const duplicates = findLikelyDuplicates(ledger, {
      account,
      amountMinor,
      date,
      description,
      windowDays,
    });
    if (duplicates.length > 0) {
      return { duplicate: duplicates[0] };
    }
  }

  const kind: UncategorizedKind = amountMinor < 0 ? 'expense' : 'income';

  // Attempt to resolve a category via high-confidence vendor rule matching.
  // If no match or low confidence or type mismatch, fall back to Uncategorized.
  const rules = rulesParam ?? loadRules();
  let offsettingAccount = resolveCategoryForEntry(ledger, {
    payee: description ?? '',
    memo,
    expectedKind: kind,
    rules,
  });

  // Fall back to Uncategorized if no high-confidence match
  if (!offsettingAccount) {
    offsettingAccount = ensureUncategorizedAccount(ledger, kind);
  }

  const result = postTransaction(ledger, {
    date,
    description: description ?? undefined,
    splits: [
      { account, amount: amountMinor, memo },
      { account: offsettingAccount.id, amount: -amountMinor, memo },
    ],
    approved,
  });

  return result;
}

export interface ImportCsvRowsOptions {
  account: string | number;
  windowDays?: number;
  forceDuplicates?: boolean;
  approved?: boolean;
}

export interface ImportCsvRowsResult {
  imported: Array<{ row: number; transactionId: number }>;
  skippedDuplicates: Array<{ row: number; transactionId: number; date: string; description: string | null }>;
  errors: Array<{ row: number; reason: string }>;
}

/**
 * Parse and post every CSV data row, one call to postIngestedEntry per row.
 * Row numbers are 1-indexed data rows plus the header row (row 2 = first
 * data row). Never throws for row-level problems (bad date/amount, unknown
 * account, imbalance, threshold-blocked, duplicate) — every failure is
 * collected in `errors` or `skippedDuplicates` so the caller can report a
 * complete per-row breakdown. Only file/header-level problems (thrown by
 * `detectColumns` before this is called) should abort the whole import.
 *
 * Loads vendor rules once per call and passes them through to all
 * postIngestedEntry calls to avoid redundant file reads.
 */
export function importCsvRows(
  ledger: Ledger,
  rows: string[][],
  cols: ColumnMap,
  opts: ImportCsvRowsOptions
): ImportCsvRowsResult {
  const { account, windowDays, forceDuplicates, approved } = opts;

  // Load rules once per import call, not per row
  const rules = loadRules();

  const imported: ImportCsvRowsResult['imported'] = [];
  const skippedDuplicates: ImportCsvRowsResult['skippedDuplicates'] = [];
  const errors: ImportCsvRowsResult['errors'] = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // account for header row + 1-indexing

    let date: string;
    let amountMinor: number;
    try {
      date = parseDate(row[cols.dateCol] ?? '');
      amountMinor = parseAmountCents(row, cols);
    } catch (err: any) {
      errors.push({ row: rowNum, reason: err.message });
      return;
    }

    const description = (row[cols.descriptionCol] ?? '').trim() || null;

    try {
      const result = postIngestedEntry(ledger, {
        date,
        amountMinor,
        account,
        description,
        force: forceDuplicates ?? false,
        approved: approved ?? false,
        windowDays,
        rules,
      });

      if ('duplicate' in result) {
        const dup = result.duplicate;
        skippedDuplicates.push({
          row: rowNum,
          transactionId: dup.transactionId,
          date: dup.date,
          description: dup.description,
        });
      } else {
        imported.push({ row: rowNum, transactionId: result.transactionId });
      }
    } catch (err: any) {
      errors.push({ row: rowNum, reason: err.message });
    }
  });

  return { imported, skippedDuplicates, errors };
}
