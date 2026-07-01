/**
 * Double-entry ledger core: pi-agnostic, unit-testable.
 * Backed by SQLite via node:sqlite (DatabaseSync).
 *
 * Amounts are always integers in minor units (cents).
 * Signed convention: positive = debit, negative = credit.
 * A balanced transaction has SUM(amount) = 0.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { SCHEMA_SQL, DEFAULT_CHART, ACCOUNT_TYPES, NORMAL_BALANCE_BY_TYPE, AccountType } from './schema.ts';
import { checkAutoPost, logAnomaly } from './policy.ts';

/**
 * Represents a ledger handle with prepared statements.
 */
export interface Ledger {
  db: DatabaseSync;
  // Prepared statement cache can be added here if needed
}

/**
 * Account as returned by the DB.
 */
export interface Account {
  id: number;
  name: string;
  type: AccountType;
  parent_id: number | null;
  normal_balance: 'debit' | 'credit';
  created_at: number;
}

/**
 * Transaction header (with computed splits array).
 */
export interface Transaction {
  id: number;
  date: string;
  description: string | null;
  source_path: string | null;
  created_at: number;
}

export interface Split {
  id: number;
  transaction_id: number;
  account_id: number;
  amount: number;
  memo: string | null;
}

export interface TransactionWithSplits extends Transaction {
  splits: Split[];
}

/**
 * Open or create a ledger at the given path.
 * If no path, uses env BOOKKEEPING_DB_PATH or defaults to <cwd>/data/bookkeeping.db.
 * Creates parent directories, applies pragmas, seeds default chart.
 * Idempotent: safe to call multiple times.
 */
export function openLedger(dbPath?: string): Ledger {
  // Resolve the path
  const finalPath = dbPath || process.env.BOOKKEEPING_DB_PATH || './data/bookkeeping.db';
  const resolvedPath = finalPath === ':memory:' ? ':memory:' : resolve(finalPath);

  // Ensure parent directory exists
  if (resolvedPath !== ':memory:') {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  // Open database
  const db = new DatabaseSync(resolvedPath);

  // Apply pragmas
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Run schema (idempotent)
  db.exec(SCHEMA_SQL);

  // Seed default chart
  seedDefaultChart({ db });

  return { db };
}

/**
 * Seed the default chart of accounts if not already present.
 * Uses INSERT OR IGNORE to avoid duplicates.
 */
export function seedDefaultChart(ledger: Ledger): void {
  const { db } = ledger;

  for (const { name, type } of DEFAULT_CHART) {
    db.prepare(
      `INSERT OR IGNORE INTO accounts (name, type, parent_id, normal_balance, created_at)
       VALUES (?, ?, NULL, ?, ?)`
    ).run(name, type, NORMAL_BALANCE_BY_TYPE[type], Date.now());
  }
}

/**
 * Resolve an account by name or id. Throws if not found.
 */
export function resolveAccount(ledger: Ledger, ref: string | number): Account {
  let account: Account | undefined;

  if (typeof ref === 'number') {
    account = ledger.db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(ref) as Account | undefined;
  } else {
    // Normalize leading @
    const name = ref.startsWith('@') ? ref.slice(1) : ref;
    account = ledger.db
      .prepare('SELECT * FROM accounts WHERE name = ?')
      .get(name) as Account | undefined;
  }

  if (!account) {
    throw new Error(`Account not found: ${ref}`);
  }

  return account;
}

/**
 * Create an account. Returns the created account.
 *
 * - If `type` is not specified, it is derived from the root (first segment).
 * - If the root doesn't exist and `type` is not provided, throws.
 * - If `type` is provided, it must match the root's type or throw.
 * - Intermediate parents are auto-created if missing.
 */
export function createAccount(
  ledger: Ledger,
  opts: {
    name: string;
    type?: AccountType;
    parent?: number | string;
  }
): Account {
  const { name, type: explicitType, parent: parentRef } = opts;

  // Parse colon-path to find root
  const parts = name.split(':');
  const rootName = parts[0];

  let rootAccount: Account | undefined;
  try {
    rootAccount = resolveAccount(ledger, rootName);
  } catch {
    // Root doesn't exist
    if (!explicitType) {
      throw new Error(
        `Unknown root account '${rootName}'. Cannot auto-create without explicit type.`
      );
    }
  }

  // If root exists, check type consistency
  if (rootAccount) {
    if (explicitType && explicitType !== rootAccount.type) {
      throw new Error(
        `Account type mismatch: '${name}' specifies type '${explicitType}' but root '${rootName}' is type '${rootAccount.type}'`
      );
    }
  }

  // Determine the type for this account
  const finalType = explicitType || rootAccount?.type;
  if (!finalType) {
    throw new Error(`Cannot determine type for account '${name}'`);
  }

  // Check if account already exists
  const existing = ledger.db
    .prepare('SELECT id FROM accounts WHERE name = ?')
    .get(name) as { id: number } | undefined;
  if (existing) {
    throw new Error(`Account '${name}' already exists`);
  }

  // Auto-create parent if needed
  let finalParentId: number | null = null;
  if (parts.length > 1) {
    const parentName = parts.slice(0, -1).join(':');
    let parentAccount: Account | undefined;
    try {
      parentAccount = resolveAccount(ledger, parentName);
    } catch {
      // Parent doesn't exist; create it recursively
      parentAccount = createAccount(ledger, { name: parentName, type: finalType });
    }
    finalParentId = parentAccount.id;
  }

  // Insert the account
  const stmt = ledger.db.prepare(
    `INSERT INTO accounts (name, type, parent_id, normal_balance, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(
    name,
    finalType,
    finalParentId,
    NORMAL_BALANCE_BY_TYPE[finalType],
    Date.now()
  );

  // Fetch and return
  return resolveAccount(ledger, name);
}

/**
 * Post a transaction (multiple splits, balanced).
 *
 * Validations (throw + logAnomaly on failure):
 * - At least 2 splits
 * - Every account must exist
 * - Every amount must be a non-zero integer
 * - Sum of amounts must be zero (balanced)
 * - Total debits must be <= threshold (unless approved)
 *
 * On success, inserts transaction and splits in a transaction.
 * On failure, writes nothing (rollback).
 *
 * Returns { transactionId, splitIds }.
 */
export function postTransaction(
  ledger: Ledger,
  opts: {
    date: string;
    description?: string;
    splits: Array<{
      account: string | number;
      amount: number; // integer minor units (signed: + = debit, - = credit)
      memo?: string;
    }>;
    sourcePath?: string;
    approved?: boolean;
  }
): { transactionId: number; splitIds: number[] } {
  const { date, description, splits, sourcePath, approved } = opts;

  // Validation: at least 2 splits
  if (!splits || splits.length < 2) {
    const detail = 'Transaction must have at least 2 splits';
    logAnomaly({ kind: 'imbalanced', detail });
    throw new Error(detail);
  }

  // Validation: every amount must be non-zero integer
  let totalAmount = 0;
  let totalDebits = 0;
  for (const split of splits) {
    if (!Number.isInteger(split.amount)) {
      const detail = `Split amount must be an integer, got: ${split.amount}`;
      logAnomaly({ kind: 'imbalanced', detail });
      throw new Error(detail);
    }
    if (split.amount === 0) {
      const detail = 'Split amount cannot be zero';
      logAnomaly({ kind: 'imbalanced', detail });
      throw new Error(detail);
    }
    totalAmount += split.amount;
    if (split.amount > 0) {
      totalDebits += split.amount;
    }
  }

  // Validation: balanced (sum to zero)
  if (totalAmount !== 0) {
    const detail = `Transaction is imbalanced: sum of amounts is ${totalAmount} (not zero)`;
    logAnomaly({ kind: 'imbalanced', detail });
    throw new Error(detail);
  }

  // Validation: every account must exist
  for (const split of splits) {
    try {
      resolveAccount(ledger, split.account);
    } catch {
      const detail = `Unknown account: ${split.account}`;
      logAnomaly({ kind: 'unknown_account', detail });
      throw new Error(detail);
    }
  }

  // Validation: threshold gate
  const checkResult = checkAutoPost(totalDebits, { approved });
  if (!checkResult.allowed) {
    const detail = `Transaction blocked: total debits ${totalDebits / 100} exceed auto-post limit ${checkResult.limitMinor / 100}`;
    logAnomaly({
      kind: 'above_threshold',
      detail,
      magnitudeMinor: totalDebits,
      limitMinor: checkResult.limitMinor,
    });
    throw new Error(
      `Transaction exceeds auto-post limit of $${(checkResult.limitMinor / 100).toFixed(2)}. Set approved: true to override.`
    );
  }

  // All validations passed; insert
  const db = ledger.db;
  let transactionId: number;
  let splitIds: number[] = [];

  try {
    db.exec('BEGIN IMMEDIATE');

    // Insert transaction header
    const txStmt = db.prepare(
      `INSERT INTO transactions (date, description, source_path, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const txResult = txStmt.run(date, description || null, sourcePath || null, Date.now());
    transactionId = txResult.lastInsertRowid as number;

    // Insert splits
    const splitStmt = db.prepare(
      `INSERT INTO splits (transaction_id, account_id, amount, memo)
       VALUES (?, ?, ?, ?)`
    );
    for (const split of splits) {
      const account = resolveAccount(ledger, split.account);
      const splitResult = splitStmt.run(
        transactionId,
        account.id,
        split.amount,
        split.memo || null
      );
      splitIds.push(splitResult.lastInsertRowid as number);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { transactionId, splitIds };
}

/**
 * Get the balance of an account.
 * Returns { accountId, name, type, normalBalance, rawMinor, naturalMinor }.
 *
 * rawMinor = SUM(amount) (may be positive or negative)
 * naturalMinor = adjusted by normal balance direction:
 *   - debit-normal: naturalMinor = rawMinor
 *   - credit-normal: naturalMinor = -rawMinor
 *
 * If asOf is provided (YYYY-MM-DD), only include transactions on or before that date.
 * If includeChildren is true, sum all descendants; otherwise exact account only.
 */
export function getBalance(
  ledger: Ledger,
  opts: {
    account: string | number;
    asOf?: string;
    includeChildren?: boolean;
  }
): {
  accountId: number;
  name: string;
  type: AccountType;
  normalBalance: 'debit' | 'credit';
  rawMinor: number;
  naturalMinor: number;
} {
  const { account: accountRef, asOf, includeChildren } = opts;
  const acc = resolveAccount(ledger, accountRef);

  // Build the query
  let sql = `
    SELECT SUM(s.amount) as balance
    FROM splits s
    JOIN transactions t ON s.transaction_id = t.id
    WHERE s.account_id = ?
  `;
  const params: (string | number)[] = [acc.id];

  if (asOf) {
    sql += ' AND t.date <= ?';
    params.push(asOf);
  }

  if (includeChildren) {
    // Include descendants by checking parent chain
    // For now, simple approach: also sum all direct children (not recursive)
    sql = `
      SELECT SUM(s.amount) as balance
      FROM splits s
      JOIN transactions t ON s.transaction_id = t.id
      WHERE s.account_id IN (
        SELECT id FROM accounts WHERE id = ? OR parent_id = ?
      )
    `;
    params[0] = acc.id;
    params.push(acc.id);
    if (asOf) {
      sql += ' AND t.date <= ?';
      params.push(asOf);
    }
  }

  const result = ledger.db
    .prepare(sql)
    .get(...params) as { balance: number | null } | undefined;

  const rawMinor = result?.balance ?? 0;
  const naturalMinor =
    acc.normal_balance === 'debit' ? rawMinor : -rawMinor;

  return {
    accountId: acc.id,
    name: acc.name,
    type: acc.type,
    normalBalance: acc.normal_balance,
    rawMinor,
    naturalMinor,
  };
}

/**
 * List all accounts, ordered by name.
 */
export function listAccounts(ledger: Ledger): Account[] {
  return ledger.db
    .prepare('SELECT * FROM accounts ORDER BY name')
    .all() as unknown as Account[];
}

/**
 * List transactions with optional filters.
 * Returns in order by date, then id.
 */
export function listTransactions(
  ledger: Ledger,
  opts?: {
    account?: string | number;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }
): TransactionWithSplits[] {
  const { account: accountRef, startDate, endDate, limit = 100 } = opts || {};

  let sql = `
    SELECT DISTINCT t.id, t.date, t.description, t.source_path, t.created_at
    FROM transactions t
  `;
  const params: (string | number)[] = [];

  if (accountRef !== undefined) {
    const acc = resolveAccount(ledger, accountRef);
    sql += ` JOIN splits s ON t.id = s.transaction_id WHERE s.account_id = ?`;
    params.push(acc.id);
  } else {
    sql += ` WHERE 1=1`;
  }

  if (startDate) {
    sql += ` AND t.date >= ?`;
    params.push(startDate);
  }
  if (endDate) {
    sql += ` AND t.date <= ?`;
    params.push(endDate);
  }

  sql += ` ORDER BY t.date, t.id LIMIT ?`;
  params.push(limit);

  const transactions = ledger.db
    .prepare(sql)
    .all(...params) as unknown as Transaction[];

  // Fetch splits for each transaction
  const withSplits: TransactionWithSplits[] = transactions.map((tx) => {
    const splits = ledger.db
      .prepare(
        `SELECT id, transaction_id, account_id, amount, memo FROM splits
         WHERE transaction_id = ? ORDER BY id`
      )
      .all(tx.id) as unknown as Split[];
    return { ...tx, splits };
  });

  return withSplits;
}

/**
 * Close the ledger (close DB connection).
 */
export function closeLedger(ledger: Ledger): void {
  ledger.db.close();
}
