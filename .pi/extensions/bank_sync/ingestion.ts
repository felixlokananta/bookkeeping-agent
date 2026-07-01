/**
 * Ingestion posting core: pi-agnostic, unit-testable.
 * Shared by `log_transaction` and `import_csv` so both behave identically:
 * same duplicate check, same sign/offset-account inference (design decision
 * #1 in plan.md).
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import {
  createAccount,
  postTransaction,
  resolveAccount,
  type Account,
  type Ledger,
} from '../bookkeeping/ledger.ts';
import { findLikelyDuplicates, type DuplicateMatch } from './dedupe.ts';

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

export interface PostIngestedEntryOptions {
  date: string;
  amountMinor: number;
  account: string | number;
  description: string | null | undefined;
  memo?: string;
  force?: boolean;
  approved?: boolean;
  windowDays?: number;
}

export type PostIngestedEntryResult =
  | { transactionId: number; splitIds: number[] }
  | { duplicate: DuplicateMatch };

/**
 * Post a single ingested entry as a balanced two-split transaction against
 * `account` and the inferred Uncategorized account. Sign convention matches
 * `post_transaction`: negative amountMinor = money out (expense, debits
 * Expenses:Uncategorized), positive = money in (income, credits
 * Income:Uncategorized).
 *
 * Runs findLikelyDuplicates first (skipped if `force`); if a duplicate is
 * found, returns { duplicate } instead of posting. Re-throws postTransaction
 * errors (imbalance/threshold) unchanged.
 */
export function postIngestedEntry(
  ledger: Ledger,
  opts: PostIngestedEntryOptions
): PostIngestedEntryResult {
  const { date, amountMinor, account, description, memo, force, approved, windowDays } = opts;

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
  const uncategorized = ensureUncategorizedAccount(ledger, kind);

  const result = postTransaction(ledger, {
    date,
    description: description ?? undefined,
    splits: [
      { account, amount: amountMinor, memo },
      { account: uncategorized.id, amount: -amountMinor, memo },
    ],
    approved,
  });

  return result;
}
