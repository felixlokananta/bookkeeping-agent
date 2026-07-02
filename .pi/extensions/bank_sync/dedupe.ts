/**
 * Duplicate detection core: pi-agnostic, unit-testable.
 * Shared by `log_transaction` and `import_csv` so "duplicate" means the same
 * thing in the conversational and bulk paths.
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import { listTransactions, resolveAccount, type Ledger } from '../bookkeeping/ledger.ts';

export interface DuplicateMatch {
  transactionId: number;
  date: string;
  description: string | null;
}

export interface FindDuplicatesOptions {
  account: string | number;
  amountMinor: number;
  date: string;
  description: string | null | undefined;
  windowDays?: number;
}

/**
 * Parse a YYYY-MM-DD date string as UTC midnight (no timezone library).
 */
function parseIsoDateUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Format a UTC-midnight timestamp back to YYYY-MM-DD.
 */
function formatIsoDateUtc(ts: number): string {
  const dt = new Date(ts);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stoplist of common, low-signal banking tokens that shouldn't be used for fuzzy matching.
 * These are too generic to meaningfully distinguish between different transactions.
 */
const FUZZY_MATCH_STOPLIST = new Set([
  'payment',
  'transfer',
  'purchase',
  'online',
  'debit',
  'card',
  'pos',
  'pmt',
  'txn',
  'ach',
  'deposit',
]);

/**
 * Normalize a description for fuzzy comparison: lowercase, alphanumeric only.
 */
export function normalizeDescription(desc: string | null | undefined): string {
  return (desc || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Fuzzy-match two normalized descriptions: match if one contains the other,
 * or they share a token of length >= 4 (excluding stoplist tokens).
 */
export function fuzzyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const normA = normalizeDescription(a);
  const normB = normalizeDescription(b);
  if (!normA || !normB) return false;

  const compactA = normA.replace(/ /g, '');
  const compactB = normB.replace(/ /g, '');
  if (compactA.includes(compactB) || compactB.includes(compactA)) return true;

  const tokensA = new Set(
    normA
      .split(' ')
      .filter((t) => t.length >= 4 && !FUZZY_MATCH_STOPLIST.has(t))
  );
  const tokensB = normB
    .split(' ')
    .filter((t) => t.length >= 4 && !FUZZY_MATCH_STOPLIST.has(t));
  for (const token of tokensB) {
    if (tokensA.has(token)) return true;
  }
  return false;
}

/**
 * Find transactions likely to be duplicates of a candidate entry: within a
 * +/- windowDays window of `date`, with a split on `account` whose amount
 * exactly matches `amountMinor` (sign-aware), and whose description
 * fuzzy-matches `description`.
 */
export function findLikelyDuplicates(
  ledger: Ledger,
  opts: FindDuplicatesOptions
): DuplicateMatch[] {
  const { account, amountMinor, date, description, windowDays = 3 } = opts;

  const acc = resolveAccount(ledger, account);

  const centerTs = parseIsoDateUtc(date);
  const startDate = formatIsoDateUtc(centerTs - windowDays * DAY_MS);
  const endDate = formatIsoDateUtc(centerTs + windowDays * DAY_MS);

  // listTransactions defaults to limit: 100; a ± windowDays date range for a
  // single account is expected to hold far fewer rows than this for a
  // single-operator ledger, but the cap is raised well above the default so
  // a busy account/day doesn't silently miss a duplicate match.
  const candidates = listTransactions(ledger, {
    account: acc.id,
    startDate,
    endDate,
    limit: 10000,
  });

  const matches: DuplicateMatch[] = [];
  for (const tx of candidates) {
    const matchingSplit = tx.splits.find(
      (s) => s.account_id === acc.id && s.amount === amountMinor
    );
    if (!matchingSplit) continue;

    if (!fuzzyMatch(tx.description, description)) continue;

    matches.push({ transactionId: tx.id, date: tx.date, description: tx.description });
  }

  return matches;
}
