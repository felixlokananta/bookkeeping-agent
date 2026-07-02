/**
 * Core reporting logic: pi-agnostic, unit-testable.
 * Implements spending-by-category, P&L, balance sheet, and tax export reports.
 * All functions operate on the ledger via pure-function queries.
 */

import type { Ledger, Account } from '../bookkeeping/ledger.ts';
import { resolveAccount, getBalance, listTransactions, listAccounts } from '../bookkeeping/ledger.ts';
import { toMajor } from '../bookkeeping/money.ts';

/**
 * Convert a raw signed split amount (positive=debit, negative=credit) to natural
 * balance for the given account: positive for debit-normal accounts (assets,
 * expenses), negated for credit-normal accounts (liabilities, equity, income).
 */
function toNatural(account: Account, rawMinor: number): number {
  return account.normal_balance === 'debit' ? rawMinor : -rawMinor;
}

/**
 * Recursively retrieve all descendant account IDs for a given account.
 * Unlike getBalance({ includeChildren: true }), which only sums direct children,
 * this walks the full ancestor tree to support arbitrary-depth drill-down.
 */
export function getDescendantAccountIds(ledger: Ledger, accountId: number): number[] {
  const result: number[] = [accountId];
  const queue: number[] = [accountId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = ledger.db
      .prepare('SELECT id FROM accounts WHERE parent_id = ?')
      .all(current) as Array<{ id: number }>;

    for (const child of children) {
      result.push(child.id);
      queue.push(child.id);
    }
  }

  return result;
}

/**
 * Spending by category: sum splits into Expenses (or a given root) within a date range,
 * grouped by account with a children breakdown.
 *
 * Returns array of { accountName, totalMinor, children: [...] }.
 * totalMinor is in natural balance (absolute value, positive for expenses).
 */
export interface SpendingByCategoryOpts {
  startDate: string;
  endDate: string;
  rootAccount?: string;
}

export interface SpendingCategory {
  accountName: string;
  totalMinor: number;
  children: SpendingCategory[];
}

export function spendingByCategory(
  ledger: Ledger,
  opts: SpendingByCategoryOpts
): SpendingCategory[] {
  const { startDate, endDate, rootAccount = 'Expenses' } = opts;

  // Build a map of all accounts by ID to avoid N+1 resolveAccount calls
  const allAccounts = listAccounts(ledger);
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  // Resolve the root account
  const rootAcc = resolveAccount(ledger, rootAccount);

  // Get all descendant account IDs
  const descendantIds = getDescendantAccountIds(ledger, rootAcc.id);

  // Query all splits in date range for these accounts
  const sql = `
    SELECT s.account_id, SUM(s.amount) as total_amount
    FROM splits s
    JOIN transactions t ON s.transaction_id = t.id
    WHERE s.account_id IN (${descendantIds.map(() => '?').join(',')})
      AND t.date >= ?
      AND t.date <= ?
    GROUP BY s.account_id
  `;
  const params = [...descendantIds, startDate, endDate];
  const rows = ledger.db.prepare(sql).all(...params) as Array<{
    account_id: number;
    total_amount: number;
  }>;

  // Build a map of accountId -> totalMinor (in natural balance)
  const balances = new Map<number, number>();
  for (const row of rows) {
    const acc = accountMap.get(row.account_id)!;
    balances.set(row.account_id, toNatural(acc, row.total_amount));
  }

  // Build the tree structure recursively
  function buildTree(accountId: number): SpendingCategory | null {
    const balance = balances.get(accountId);
    const acc = accountMap.get(accountId)!;

    // Get direct children and build their subtrees
    const children: SpendingCategory[] = [];
    const childAccounts = ledger.db
      .prepare('SELECT id FROM accounts WHERE parent_id = ? ORDER BY name')
      .all(accountId) as Array<{ id: number }>;

    for (const childAcc of childAccounts) {
      const childTree = buildTree(childAcc.id);
      if (childTree) {
        children.push(childTree);
      }
    }

    // Calculate total: own balance + sum of children's totals
    let totalMinor = balance ?? 0;
    for (const child of children) {
      totalMinor += child.totalMinor;
    }

    // Skip if no balance at all (no splits in this account or descendants) and not root
    if (totalMinor === 0 && accountId !== rootAcc.id) {
      return null;
    }

    return {
      accountName: acc.name,
      totalMinor,
      children,
    };
  }

  const rootTree = buildTree(rootAcc.id);
  return rootTree ? [rootTree] : [];
}

/**
 * Income statement (P&L): sum income and expense accounts within a date range.
 *
 * Returns { incomeMinor, expenseMinor, netIncomeMinor, incomeByAccount, expenseByAccount }
 * All amounts in natural balance (positive for income/expenses).
 */
export interface IncomeStatementOpts {
  /** Omit for an open-ended lower bound (all transactions up to endDate). */
  startDate?: string;
  endDate: string;
}

export interface IncomeStatementResult {
  incomeMinor: number;
  expenseMinor: number;
  netIncomeMinor: number;
  incomeByAccount: Array<{ accountName: string; totalMinor: number }>;
  expenseByAccount: Array<{ accountName: string; totalMinor: number }>;
}

export function incomeStatement(
  ledger: Ledger,
  opts: IncomeStatementOpts
): IncomeStatementResult {
  const { startDate, endDate } = opts;

  // Get all income and expense accounts
  const allAccounts = listAccounts(ledger);
  const incomeAccounts = allAccounts.filter((a) => a.type === 'income');
  const expenseAccounts = allAccounts.filter((a) => a.type === 'expense');

  // Single grouped query for split totals across all income/expense accounts in range.
  const relevantAccounts = [...incomeAccounts, ...expenseAccounts];
  const rawTotals = new Map<number, number>();

  if (relevantAccounts.length > 0) {
    const sql = `
      SELECT s.account_id, SUM(s.amount) as total_amount
      FROM splits s
      JOIN transactions t ON s.transaction_id = t.id
      WHERE s.account_id IN (${relevantAccounts.map(() => '?').join(',')})
        ${startDate ? 'AND t.date >= ?' : ''}
        AND t.date <= ?
      GROUP BY s.account_id
    `;
    const params = [
      ...relevantAccounts.map((a) => a.id),
      ...(startDate ? [startDate] : []),
      endDate,
    ];
    const rows = ledger.db.prepare(sql).all(...params) as Array<{
      account_id: number;
      total_amount: number;
    }>;
    for (const row of rows) {
      rawTotals.set(row.account_id, row.total_amount);
    }
  }

  // Sum splits for income accounts
  const incomeByAccount: Array<{ accountName: string; totalMinor: number }> = [];
  let incomeMinor = 0;

  for (const acc of incomeAccounts) {
    const natural = toNatural(acc, rawTotals.get(acc.id) ?? 0);
    if (natural !== 0) {
      incomeByAccount.push({ accountName: acc.name, totalMinor: natural });
    }
    incomeMinor += natural;
  }

  // Sum splits for expense accounts
  const expenseByAccount: Array<{ accountName: string; totalMinor: number }> = [];
  let expenseMinor = 0;

  for (const acc of expenseAccounts) {
    const natural = toNatural(acc, rawTotals.get(acc.id) ?? 0);
    if (natural !== 0) {
      expenseByAccount.push({ accountName: acc.name, totalMinor: natural });
    }
    expenseMinor += natural;
  }

  const netIncomeMinor = incomeMinor - expenseMinor;

  return {
    incomeMinor,
    expenseMinor,
    netIncomeMinor,
    incomeByAccount,
    expenseByAccount,
  };
}

/**
 * Balance sheet: sum asset/liability/equity accounts as of a given date.
 * Includes retained earnings (cumulative net income) to satisfy Assets = Liabilities + Equity.
 *
 * Returns { assets, liabilities, equityAccounts, retainedEarnings, totalAssetsMinor, totalLiabilitiesAndEquityMinor }
 *
 * Note: equityAccounts includes a synthetic "Retained Earnings" row (cumulative net income) alongside
 * posted equity accounts whenever it's non-zero, so its entries always sum to totalEquityMinor.
 * retainedEarnings is also returned standalone for callers that need the raw figure without walking the array.
 */
export interface BalanceSheetOpts {
  asOf: string;
}

export interface BalanceSheetAccount {
  accountName: string;
  totalMinor: number;
}

export interface BalanceSheetResult {
  assets: BalanceSheetAccount[];
  liabilities: BalanceSheetAccount[];
  equityAccounts: BalanceSheetAccount[];
  retainedEarnings: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  totalLiabilitiesAndEquityMinor: number;
}

export function balanceSheet(ledger: Ledger, opts: BalanceSheetOpts): BalanceSheetResult {
  const { asOf } = opts;

  // Get all accounts
  const allAccounts = listAccounts(ledger);

  // Helper: sum balance for an account and its descendants as of asOf
  function getAccountBalance(accountId: number): number {
    const descendants = getDescendantAccountIds(ledger, accountId);
    const sql = `
      SELECT SUM(s.amount) as total_amount
      FROM splits s
      JOIN transactions t ON s.transaction_id = t.id
      WHERE s.account_id IN (${descendants.map(() => '?').join(',')})
        AND t.date <= ?
    `;
    const params = [...descendants, asOf];
    const result = ledger.db.prepare(sql).get(...params) as
      | { total_amount: number | null }
      | undefined;
    return result?.total_amount ?? 0;
  }

  // Collect balances by account type
  const assets: BalanceSheetAccount[] = [];
  let totalAssetsMinor = 0;

  const liabilities: BalanceSheetAccount[] = [];
  let totalLiabilitiesMinor = 0;

  const equityAccounts: BalanceSheetAccount[] = [];
  let totalEquityMinor = 0;

  for (const acc of allAccounts) {
    // Skip non-root accounts (they're included via descendants)
    if (acc.parent_id !== null) {
      continue;
    }

    const rawMinor = getAccountBalance(acc.id);
    const natural = toNatural(acc, rawMinor);

    if (natural === 0) {
      continue;
    }

    const item = { accountName: acc.name, totalMinor: natural };

    if (acc.type === 'asset') {
      assets.push(item);
      totalAssetsMinor += natural;
    } else if (acc.type === 'liability') {
      liabilities.push(item);
      totalLiabilitiesMinor += natural;
    } else if (acc.type === 'equity') {
      equityAccounts.push(item);
      totalEquityMinor += natural;
    }
  }

  // Calculate retained earnings: cumulative net income to date (no lower bound)
  const incomeStatementAllTime = incomeStatement(ledger, { endDate: asOf });
  const retainedEarnings = incomeStatementAllTime.netIncomeMinor;

  // Add synthetic "Retained Earnings" row to equityAccounts if non-zero
  if (retainedEarnings !== 0) {
    equityAccounts.push({ accountName: 'Retained Earnings', totalMinor: retainedEarnings });
  }

  // Total liabilities and equity = liabilities + equity + retained earnings
  const totalLiabilitiesAndEquityMinor = totalLiabilitiesMinor + totalEquityMinor + retainedEarnings;

  return {
    assets,
    liabilities,
    equityAccounts,
    retainedEarnings,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor: totalEquityMinor + retainedEarnings,
    totalLiabilitiesAndEquityMinor,
  };
}

/**
 * Tax year export: list splits in income/expense accounts for a given year.
 * Each row: { date, accountName, description, amountMajor }
 */
export interface TaxYearExportOpts {
  year: number;
}

export interface TaxYearRow {
  date: string;
  accountName: string;
  description: string | null;
  amountMajor: number;
}

export function taxYearExport(ledger: Ledger, opts: TaxYearExportOpts): TaxYearRow[] {
  const { year } = opts;
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // Get all income and expense accounts
  const allAccounts = listAccounts(ledger);
  const relevantAccounts = allAccounts.filter(
    (a) => a.type === 'income' || a.type === 'expense'
  );
  const accountIds = relevantAccounts.map((a) => a.id);

  // Build a map to avoid N+1 resolveAccount calls
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  if (accountIds.length === 0) {
    return [];
  }

  // Query all splits in these accounts within the year
  const sql = `
    SELECT s.id, t.date, t.description, s.account_id, s.amount
    FROM splits s
    JOIN transactions t ON s.transaction_id = t.id
    WHERE s.account_id IN (${accountIds.map(() => '?').join(',')})
      AND t.date >= ?
      AND t.date <= ?
    ORDER BY t.date, s.id
  `;
  const params = [...accountIds, startDate, endDate];
  const rows = ledger.db.prepare(sql).all(...params) as Array<{
    id: number;
    date: string;
    description: string | null;
    account_id: number;
    amount: number;
  }>;

  // Convert to export rows
  const result: TaxYearRow[] = [];
  for (const row of rows) {
    const acc = accountMap.get(row.account_id)!;
    result.push({
      date: row.date,
      accountName: acc.name,
      description: row.description,
      amountMajor: toMajor(row.amount),
    });
  }

  return result;
}
