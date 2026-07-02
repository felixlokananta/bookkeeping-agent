/**
 * Reconciliation core: pi-agnostic, unit-testable.
 * Matches statement entries to ledger splits, computes discrepancies,
 * and records reconciliation runs.
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import { readFileSync } from 'node:fs';
import { getBalance, listTransactions, resolveAccount, type Ledger } from '../bookkeeping/ledger.ts';
import {
  parseCsvText,
  detectColumns,
  parseAmountCents,
  parseDate,
  type ColumnMap,
  type ColumnOverrides,
} from '../bank_sync/csv.ts';
import { fuzzyMatch, normalizeDescription } from '../bank_sync/dedupe.ts';

// Re-export for public API
export type { ColumnOverrides };

export interface StatementRow {
  date: string;
  description: string;
  amountMinor: number;
}

export interface MatchedEntry {
  statementRow: StatementRow;
  splitId: number;
  transactionId: number;
  sourcedFromReceipt: boolean;
  receiptPath?: string | null;
}

export interface UnmatchedStatementRow {
  statementRow: StatementRow;
}

export interface UnmatchedLedgerSplit {
  splitId: number;
  transactionId: number;
  date: string;
  amount: number;
  description: string | null;
}

export interface MatchResult {
  matched: MatchedEntry[];
  ledgerOnly: UnmatchedLedgerSplit[];
  statementOnly: UnmatchedStatementRow[];
}

export interface DiffBalanceResult {
  ledgerNaturalMinor: number;
  statementBalanceMinor: number;
  discrepancyMinor: number;
}

export interface ReconcileAccountOptions {
  account: string | number;
  periodStart: string;
  periodEnd: string;
  statementBalanceMinor: number;
  statementPath?: string;
  statementRows?: StatementRow[];
  columnOverrides?: ColumnOverrides;
  windowDays?: number;
  markReconciled?: boolean;
}

/**
 * Compute the balance difference between ledger and statement.
 * Returns the ledger natural balance, statement balance, and discrepancy.
 */
export function diffStatementBalance(
  ledger: Ledger,
  opts: {
    account: string | number;
    periodEnd: string;
    statementBalanceMinor: number;
  }
): DiffBalanceResult {
  const { account, periodEnd, statementBalanceMinor } = opts;

  const balance = getBalance(ledger, {
    account,
    asOf: periodEnd,
  });

  const discrepancyMinor = balance.naturalMinor - statementBalanceMinor;

  return {
    ledgerNaturalMinor: balance.naturalMinor,
    statementBalanceMinor,
    discrepancyMinor,
  };
}

/**
 * List all splits in an account+period that have NOT been reconciled yet.
 * A split is "reconciled" iff it has a row in the `reconciliations` table.
 */
export function listUnreconciledSplits(
  ledger: Ledger,
  opts: {
    account: string | number;
    periodStart: string;
    periodEnd: string;
  }
): UnmatchedLedgerSplit[] {
  const { account, periodStart, periodEnd } = opts;
  const acc = resolveAccount(ledger, account);

  const sql = `
    SELECT s.id as splitId, s.transaction_id as transactionId, t.date, s.amount, t.description
    FROM splits s
    JOIN transactions t ON s.transaction_id = t.id
    WHERE s.account_id = ?
      AND t.date >= ?
      AND t.date <= ?
      AND NOT EXISTS (
        SELECT 1 FROM reconciliations WHERE split_id = s.id
      )
    ORDER BY t.date, s.id
  `;

  const rows = ledger.db.prepare(sql).all(acc.id, periodStart, periodEnd) as unknown as UnmatchedLedgerSplit[];
  return rows;
}

/**
 * Match statement rows to ledger splits using tiered matching:
 * Tier 1: exact amount + within windowDays of the transaction date
 * Tier 2: exact amount + fuzzy description match (for unmatched rows/splits)
 */
export function matchStatementToLedger(
  ledger: Ledger,
  opts: {
    account: string | number;
    periodStart: string;
    periodEnd: string;
    statementRows: StatementRow[];
    windowDays?: number;
  }
): MatchResult {
  const { account: accountRef, periodStart, periodEnd, statementRows, windowDays = 3 } = opts;
  const acc = resolveAccount(ledger, accountRef);

  // Get all unreconciled splits in the period
  const unreconciled = listUnreconciledSplits(ledger, {
    account: acc.id,
    periodStart,
    periodEnd,
  });

  // Track which statement rows and ledger splits have been matched
  const matchedStatementIndices = new Set<number>();
  const matchedSplitIds = new Set<number>();

  const matched: MatchedEntry[] = [];

  // Tier 1: exact amount + date within window
  for (let i = 0; i < statementRows.length; i++) {
    if (matchedStatementIndices.has(i)) continue;

    const stmtRow = statementRows[i];
    const stmtDate = parseIsoDateUtc(stmtRow.date);
    const windowMs = windowDays * DAY_MS;

    for (const split of unreconciled) {
      if (matchedSplitIds.has(split.splitId)) continue;

      // Check exact amount match
      if (split.amount !== stmtRow.amountMinor) continue;

      // Check date proximity
      const splitDate = parseIsoDateUtc(split.date);
      if (Math.abs(splitDate - stmtDate) <= windowMs) {
        // Match found!
        const txWithSplits = ledger.db.prepare(
          'SELECT source_path FROM transactions WHERE id = ?'
        ).get(split.transactionId) as { source_path: string | null } | undefined;

        matched.push({
          statementRow: stmtRow,
          splitId: split.splitId,
          transactionId: split.transactionId,
          sourcedFromReceipt: txWithSplits?.source_path != null,
          receiptPath: txWithSplits?.source_path,
        });

        matchedStatementIndices.add(i);
        matchedSplitIds.add(split.splitId);
        break;
      }
    }
  }

  // Tier 2: exact amount + fuzzy description (only for unmatched rows/splits)
  for (let i = 0; i < statementRows.length; i++) {
    if (matchedStatementIndices.has(i)) continue;

    const stmtRow = statementRows[i];

    for (const split of unreconciled) {
      if (matchedSplitIds.has(split.splitId)) continue;

      // Check exact amount match
      if (split.amount !== stmtRow.amountMinor) continue;

      // Check fuzzy description match
      if (fuzzyMatch(split.description, stmtRow.description)) {
        // Match found!
        const txWithSplits = ledger.db.prepare(
          'SELECT source_path FROM transactions WHERE id = ?'
        ).get(split.transactionId) as { source_path: string | null } | undefined;

        matched.push({
          statementRow: stmtRow,
          splitId: split.splitId,
          transactionId: split.transactionId,
          sourcedFromReceipt: txWithSplits?.source_path != null,
          receiptPath: txWithSplits?.source_path,
        });

        matchedStatementIndices.add(i);
        matchedSplitIds.add(split.splitId);
        break;
      }
    }
  }

  // Collect unmatched statement rows and ledger splits
  const statementOnly: UnmatchedStatementRow[] = [];
  for (let i = 0; i < statementRows.length; i++) {
    if (!matchedStatementIndices.has(i)) {
      statementOnly.push({ statementRow: statementRows[i] });
    }
  }

  const ledgerOnly: UnmatchedLedgerSplit[] = [];
  for (const split of unreconciled) {
    if (!matchedSplitIds.has(split.splitId)) {
      ledgerOnly.push(split);
    }
  }

  return {
    matched,
    ledgerOnly,
    statementOnly,
  };
}

/**
 * Main reconciliation function: diffs the balance, parses statement CSV if needed,
 * matches entries, and optionally persists the reconciliation run.
 */
export function reconcileAccount(
  ledger: Ledger,
  opts: ReconcileAccountOptions
): {
  diff: DiffBalanceResult;
  matches: MatchResult;
  runId?: number;
} {
  const {
    account,
    periodStart,
    periodEnd,
    statementBalanceMinor,
    statementPath,
    statementRows: providedRows,
    columnOverrides,
    windowDays = 3,
    markReconciled = false,
  } = opts;

  const acc = resolveAccount(ledger, account);

  // Parse statement rows from CSV or use provided rows
  let statementRows: StatementRow[];
  let sourcePathForRun: string | null = null;

  if (providedRows) {
    statementRows = providedRows;
    sourcePathForRun = statementPath || null;
  } else if (statementPath) {
    const csvText = readFileSync(statementPath, 'utf-8');
    const parsed = parseCsvText(csvText);
    const cols = detectColumns(parsed.header, columnOverrides);

    statementRows = [];
    for (const row of parsed.rows) {
      try {
        const date = parseDate(row[cols.dateCol]);
        const amountMinor = parseAmountCents(row, cols);
        const description = row[cols.descriptionCol] || '';

        statementRows.push({ date, description, amountMinor });
      } catch (err) {
        // Skip malformed rows (consistency with import_csv)
        continue;
      }
    }
    sourcePathForRun = statementPath;
  } else {
    statementRows = [];
  }

  // Compute balance diff
  const diff = diffStatementBalance(ledger, {
    account: acc.id,
    periodEnd,
    statementBalanceMinor,
  });

  // Match statement rows to ledger splits
  const matches = matchStatementToLedger(ledger, {
    account: acc.id,
    periodStart,
    periodEnd,
    statementRows,
    windowDays,
  });

  // Optionally persist reconciliation run
  let runId: number | undefined;
  if (markReconciled) {
    const db = ledger.db;
    try {
      db.exec('BEGIN IMMEDIATE');

      // Insert reconciliation run
      const runStmt = db.prepare(
        `INSERT INTO reconciliation_runs (account_id, period_start, period_end, statement_balance_minor, source_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const runResult = runStmt.run(
        acc.id,
        periodStart,
        periodEnd,
        statementBalanceMinor,
        sourcePathForRun,
        Date.now()
      );
      runId = runResult.lastInsertRowid as number;

      // Insert reconciliations for matched splits
      const reconStmt = db.prepare(
        `INSERT INTO reconciliations (run_id, split_id, created_at)
         VALUES (?, ?, ?)`
      );
      for (const match of matches.matched) {
        reconStmt.run(runId, match.splitId, Date.now());
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    diff,
    matches,
    runId,
  };
}

/**
 * Parse a YYYY-MM-DD date string as UTC midnight.
 */
function parseIsoDateUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const DAY_MS = 24 * 60 * 60 * 1000;
