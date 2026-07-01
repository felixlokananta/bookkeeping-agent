/**
 * Schema DDL, default chart of accounts, and account type constants.
 * Centralized source of truth for the ledger structure.
 */

export const ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCE_BY_TYPE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

/**
 * Default chart of accounts: five root accounts.
 * Each root is a top-level account with no parent.
 */
export const DEFAULT_CHART: Array<{ name: string; type: AccountType }> = [
  { name: 'Assets', type: 'asset' },
  { name: 'Liabilities', type: 'liability' },
  { name: 'Equity', type: 'equity' },
  { name: 'Income', type: 'income' },
  { name: 'Expenses', type: 'expense' },
];

/**
 * SQL DDL: tables, indexes, pragmas.
 * Idempotent (CREATE TABLE IF NOT EXISTS, indexes are conditional).
 */
export const SCHEMA_SQL = `
-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id INTEGER REFERENCES accounts(id),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  created_at INTEGER NOT NULL
);

-- Transactions (header)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description TEXT,
  source_path TEXT,
  created_at INTEGER NOT NULL
);

-- Splits (journal entries)
CREATE TABLE IF NOT EXISTS splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,
  memo TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_splits_account ON splits(account_id);
CREATE INDEX IF NOT EXISTS idx_splits_txn ON splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);

-- Triggers: Append-only enforcement
CREATE TRIGGER IF NOT EXISTS trg_transactions_no_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are append-only: DELETE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_splits_no_delete
BEFORE DELETE ON splits
BEGIN
  SELECT RAISE(ABORT, 'splits are append-only: DELETE not allowed');
END;

-- account_id is deliberately excluded from this column list: categorization
-- legitimately re-points a split's account_id to move it out of Uncategorized
-- or correct a prior category (see AGENTS.md hard rule 7).
CREATE TRIGGER IF NOT EXISTS trg_splits_no_update
BEFORE UPDATE OF id, transaction_id, amount, memo ON splits
BEGIN
  SELECT RAISE(ABORT, 'splits are append-only except account_id: UPDATE of this column not allowed');
END;

-- Pragmas (set per connection)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;
