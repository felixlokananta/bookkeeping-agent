/**
 * Ledger verification core: pi-agnostic, unit-testable.
 * Runs period-end integrity checks: unbalanced transactions, orphan splits,
 * trial balance, and unexpected-sign accounts.
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import { getBalance, resolveAccount, type Ledger, type Account } from '../bookkeeping/ledger.ts';

export interface UnbalancedTransaction {
  transactionId: number;
  date: string;
  description: string | null;
  sumAmount: number;
}

export interface OrphanSplit {
  splitId: number;
  transactionId: number;
  accountId: number;
  amount: number;
}

export interface UnexpectedSignAccount {
  accountId: number;
  accountName: string;
  naturalBalance: 'debit' | 'credit';
  signMismatch: 'positive_in_credit_account' | 'negative_in_debit_account';
}

export interface VerifyLedgerResult {
  unbalancedTransactions: UnbalancedTransaction[];
  orphanSplits: OrphanSplit[];
  trialBalanceMinor: number;
  trialBalanceOk: boolean;
  unexpectedSignAccounts: UnexpectedSignAccount[];
}

/**
 * Verify ledger integrity: detect unbalanced transactions, orphan splits,
 * compute trial balance, and check for unexpected-sign accounts.
 */
export function verifyLedger(
  ledger: Ledger,
  opts?: { asOf?: string }
): VerifyLedgerResult {
  const { asOf } = opts || {};

  const result: VerifyLedgerResult = {
    unbalancedTransactions: [],
    orphanSplits: [],
    trialBalanceMinor: 0,
    trialBalanceOk: false,
    unexpectedSignAccounts: [],
  };

  // Check for unbalanced transactions
  let sql = `
    SELECT t.id as transactionId, t.date, t.description, SUM(s.amount) as sumAmount
    FROM transactions t
    LEFT JOIN splits s ON t.id = s.transaction_id
  `;
  const params: (string | number)[] = [];

  if (asOf) {
    sql += ' WHERE t.date <= ?';
    params.push(asOf);
  } else {
    sql += ' WHERE 1=1';
  }

  sql += ' GROUP BY t.id HAVING SUM(s.amount) != 0';

  const unbalanced = ledger.db
    .prepare(sql)
    .all(...params) as unknown as Array<{ transactionId: number; date: string; description: string | null; sumAmount: number }>;
  result.unbalancedTransactions = unbalanced.map((row) => ({
    transactionId: row.transactionId,
    date: row.date,
    description: row.description,
    sumAmount: row.sumAmount,
  }));

  // Check for orphan splits (split referencing non-existent transaction or account)
  let orphanSql = `
    SELECT s.id as splitId, s.transaction_id as transactionId, s.account_id as accountId, s.amount
    FROM splits s
    LEFT JOIN transactions t ON s.transaction_id = t.id
    LEFT JOIN accounts a ON s.account_id = a.id
    WHERE t.id IS NULL OR a.id IS NULL
  `;
  const orphanParams: (string | number)[] = [];

  if (asOf) {
    orphanSql += ' AND (SELECT date FROM transactions WHERE id = s.transaction_id) <= ?';
    orphanParams.push(asOf);
  }

  const orphans = ledger.db.prepare(orphanSql).all(...orphanParams) as unknown as OrphanSplit[];
  result.orphanSplits = orphans;

  // Compute trial balance (sum of all split amounts should be zero)
  let balanceSql = 'SELECT COALESCE(SUM(amount), 0) as total FROM splits';
  const balanceParams: (string | number)[] = [];

  if (asOf) {
    balanceSql += ' WHERE transaction_id IN (SELECT id FROM transactions WHERE date <= ?)';
    balanceParams.push(asOf);
  }

  const balanceRow = ledger.db.prepare(balanceSql).get(...balanceParams) as { total: number } | undefined;
  result.trialBalanceMinor = balanceRow?.total ?? 0;
  result.trialBalanceOk = result.trialBalanceMinor === 0;

  // Check for unexpected-sign accounts (e.g., negative balance in debit-normal account)
  const accounts = ledger.db.prepare('SELECT id, name, normal_balance FROM accounts').all() as unknown as Account[];

  for (const account of accounts) {
    const balance = getBalance(ledger, {
      account: account.id,
      asOf,
    });

    // Check sign: debit-normal should have non-negative natural balance, credit-normal should have non-negative natural balance
    // naturalMinor represents the "natural" display direction based on normal_balance type
    // For debit-normal: negative naturalMinor is unexpected (credit direction)
    // For credit-normal: negative naturalMinor is unexpected (debit direction)
    if (account.normal_balance === 'debit' && balance.naturalMinor < 0) {
      result.unexpectedSignAccounts.push({
        accountId: account.id,
        accountName: account.name,
        naturalBalance: 'debit',
        signMismatch: 'negative_in_debit_account',
      });
    } else if (account.normal_balance === 'credit' && balance.naturalMinor < 0) {
      result.unexpectedSignAccounts.push({
        accountId: account.id,
        accountName: account.name,
        naturalBalance: 'credit',
        signMismatch: 'positive_in_credit_account',
      });
    }
  }

  return result;
}
