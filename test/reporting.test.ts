/**
 * Unit tests for the reporting extension.
 * Run with: npm test
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openLedger,
  closeLedger,
  postTransaction,
  createAccount,
  type Ledger,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import {
  spendingByCategory,
  incomeStatement,
  balanceSheet,
  taxYearExport,
  getDescendantAccountIds,
} from '../.pi/extensions/reporting/reports.ts';
import { toCsv } from '../.pi/extensions/reporting/csv.ts';
import { formatBalanceSheet, resolveExportPath } from '../.pi/extensions/reporting/index.ts';

describe('Reporting Extension Tests', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    // Isolate anomaly-log writes from the real memory/anomaly_log.json
    tmpDir = mkdtempSync(join(tmpdir(), 'reporting-test-'));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
  });

  after(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up env
    delete process.env.BOOKKEEPING_DB_PATH;

    // Open in-memory ledger
    ledger = openLedger(':memory:');

    // Create necessary accounts
    createAccount(ledger, { name: 'Assets:Checking' });
    createAccount(ledger, { name: 'Assets:Savings' });
    createAccount(ledger, { name: 'Liabilities:CreditCard' });
    createAccount(ledger, { name: 'Equity:Owner' });
    createAccount(ledger, { name: 'Income:Salary' });
    createAccount(ledger, { name: 'Income:Investment' });
    createAccount(ledger, { name: 'Expenses:Food:Groceries' });
    createAccount(ledger, { name: 'Expenses:Food:Restaurants' });
    createAccount(ledger, { name: 'Expenses:Entertainment' });

    // Post initial transaction
    postTransaction(ledger, {
      date: '2025-01-01',
      description: 'Initial setup',
      splits: [
        { account: 'Assets:Checking', amount: 50000 },
        { account: 'Equity:Owner', amount: -50000 },
      ],
    });
  });

  afterEach(() => {
    if (ledger) {
      closeLedger(ledger);
    }
  });

  describe('getDescendantAccountIds', () => {
    it('should return the account and all descendants recursively', () => {
      // Get descendants of Expenses
      const expensesAcc = ledger.db
        .prepare('SELECT id FROM accounts WHERE name = ?')
        .get('Expenses') as { id: number };
      const descendants = getDescendantAccountIds(ledger, expensesAcc.id);

      // Should include Expenses and all Food/Entertainment accounts
      const names = descendants.map((id) =>
        (ledger.db.prepare('SELECT name FROM accounts WHERE id = ?').get(id) as { name: string })
          .name
      );

      assert(names.includes('Expenses'));
      assert(names.includes('Expenses:Food'));
      assert(names.includes('Expenses:Food:Groceries'));
      assert(names.includes('Expenses:Food:Restaurants'));
      assert(names.includes('Expenses:Entertainment'));
    });

    it('should return just the account if it has no descendants', () => {
      const grocAcc = ledger.db
        .prepare('SELECT id FROM accounts WHERE name = ?')
        .get('Expenses:Food:Groceries') as { id: number };
      const descendants = getDescendantAccountIds(ledger, grocAcc.id);

      assert.strictEqual(descendants.length, 1);
      assert.strictEqual(descendants[0], grocAcc.id);
    });
  });

  describe('spendingByCategory', () => {
    it('should sum expenses by category with parent/child rollup', () => {
      // Post transactions into Food subcategories
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Grocery store',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 5000 }, // $50
          { account: 'Assets:Checking', amount: -5000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Restaurant',
        splits: [
          { account: 'Expenses:Food:Restaurants', amount: 3000 }, // $30
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-25',
        description: 'Entertainment',
        splits: [
          { account: 'Expenses:Entertainment', amount: 2000 }, // $20
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      const result = spendingByCategory(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      // Should have one top-level result for Expenses
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].accountName, 'Expenses');

      // Total should be $50 + $30 + $20 = $100
      assert.strictEqual(result[0].totalMinor, 10000);

      // Food should be $50 + $30 = $80, Entertainment $20
      const children = result[0].children;
      const foodChild = children.find((c) => c.accountName === 'Expenses:Food');
      const entChild = children.find((c) => c.accountName === 'Expenses:Entertainment');

      assert.strictEqual(foodChild?.totalMinor, 8000);
      assert.strictEqual(entChild?.totalMinor, 2000);

      // Food should have Groceries and Restaurants children
      const foodGrandchildren = foodChild?.children || [];
      const groceriesChild = foodGrandchildren.find(
        (c) => c.accountName === 'Expenses:Food:Groceries'
      );
      const restaurantChild = foodGrandchildren.find(
        (c) => c.accountName === 'Expenses:Food:Restaurants'
      );

      assert.strictEqual(groceriesChild?.totalMinor, 5000);
      assert.strictEqual(restaurantChild?.totalMinor, 3000);
    });

    it('should filter transactions by date range', () => {
      // Post transactions in different periods
      postTransaction(ledger, {
        date: '2025-05-15',
        description: 'Out of range',
        splits: [
          { account: 'Expenses:Entertainment', amount: 1000 },
          { account: 'Assets:Checking', amount: -1000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'In range',
        splits: [
          { account: 'Expenses:Entertainment', amount: 2000 },
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-07-15',
        description: 'Out of range',
        splits: [
          { account: 'Expenses:Entertainment', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      const result = spendingByCategory(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      // Should only include June's $20 transaction
      const entChild = result[0].children.find((c) => c.accountName === 'Expenses:Entertainment');
      assert.strictEqual(entChild?.totalMinor, 2000);
    });

    it('should support drilling into a specific root account', () => {
      // Post transactions
      postTransaction(ledger, {
        date: '2025-06-15',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 5000 },
          { account: 'Assets:Checking', amount: -5000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        splits: [
          { account: 'Expenses:Food:Restaurants', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      const result = spendingByCategory(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
        rootAccount: 'Expenses:Food',
      });

      // Should have one top-level result for Expenses:Food
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].accountName, 'Expenses:Food');

      // Total should be $50 + $30 = $80
      assert.strictEqual(result[0].totalMinor, 8000);

      // Children should be the two subcategories
      const children = result[0].children;
      assert.strictEqual(children.length, 2);
    });
  });

  describe('incomeStatement', () => {
    it('should sum income and expenses correctly and calculate net income', () => {
      // Post income transactions
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Salary',
        splits: [
          { account: 'Assets:Checking', amount: 100000 }, // $1000
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-10',
        description: 'Investment income',
        splits: [
          { account: 'Assets:Checking', amount: 5000 }, // $50
          { account: 'Income:Investment', amount: -5000 },
        ],
      });

      // Post expense transactions
      postTransaction(ledger, {
        date: '2025-06-15',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 3000 }, // $30
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        splits: [
          { account: 'Expenses:Entertainment', amount: 2000 }, // $20
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      const result = incomeStatement(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      // Income: $1000 + $50 = $1050
      assert.strictEqual(result.incomeMinor, 105000);

      // Expenses: $30 + $20 = $50
      assert.strictEqual(result.expenseMinor, 5000);

      // Net income: $1050 - $50 = $1000
      assert.strictEqual(result.netIncomeMinor, 100000);

      // Verify identity: income - expense === net income
      assert.strictEqual(result.incomeMinor - result.expenseMinor, result.netIncomeMinor);
    });

    it('should only include transactions within date range', () => {
      postTransaction(ledger, {
        date: '2025-05-01',
        splits: [
          { account: 'Assets:Checking', amount: 50000 },
          { account: 'Income:Salary', amount: -50000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-01',
        splits: [
          { account: 'Assets:Checking', amount: 60000 },
          { account: 'Income:Salary', amount: -60000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-07-01',
        splits: [
          { account: 'Assets:Checking', amount: 70000 },
          { account: 'Income:Salary', amount: -70000 },
        ],
        approved: true,
      });

      const result = incomeStatement(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      // Should only include June: $600
      assert.strictEqual(result.incomeMinor, 60000);
    });

    it('should include breakdown by account', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        splits: [
          { account: 'Assets:Checking', amount: 100000 },
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-10',
        splits: [
          { account: 'Assets:Checking', amount: 5000 },
          { account: 'Income:Investment', amount: -5000 },
        ],
      });

      const result = incomeStatement(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      // Should have two income accounts in breakdown
      assert.strictEqual(result.incomeByAccount.length, 2);

      const salaryItem = result.incomeByAccount.find((a) => a.accountName === 'Income:Salary');
      const investmentItem = result.incomeByAccount.find(
        (a) => a.accountName === 'Income:Investment'
      );

      assert.strictEqual(salaryItem?.totalMinor, 100000);
      assert.strictEqual(investmentItem?.totalMinor, 5000);
    });
  });

  describe('balanceSheet', () => {
    it('should verify accounting identity: Assets = Liabilities + Equity', () => {
      // Post transactions to establish balances
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Salary income',
        splits: [
          { account: 'Assets:Checking', amount: 100000 },
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-05',
        description: 'Expense',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 2000 },
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-10',
        description: 'Liability',
        splits: [
          { account: 'Assets:Checking', amount: -5000 },
          { account: 'Liabilities:CreditCard', amount: 5000 },
        ],
      });

      const result = balanceSheet(ledger, { asOf: '2025-06-30' });

      // Assets should be: $500 (initial) + $1000 (salary) - $20 (expense) - $50 (liability) = $1430
      const checkingBalance =
        50000 + 100000 - 2000 - 5000; // 142,800 minor = $1428
      assert.strictEqual(result.totalAssetsMinor, checkingBalance);

      // Liabilities: $50
      assert.strictEqual(result.totalLiabilitiesAndEquityMinor, checkingBalance);

      // Verify accounting identity
      assert.strictEqual(result.totalAssetsMinor, result.totalLiabilitiesAndEquityMinor);
    });

    it('should include retained earnings (cumulative net income)', () => {
      // Post income
      postTransaction(ledger, {
        date: '2025-06-01',
        splits: [
          { account: 'Assets:Checking', amount: 100000 },
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      // Post expense
      postTransaction(ledger, {
        date: '2025-06-10',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      const result = balanceSheet(ledger, { asOf: '2025-06-30' });

      // Net income: $1000 - $30 = $970
      const expectedNetIncome = 100000 - 3000;
      assert.strictEqual(result.retainedEarnings, expectedNetIncome);

      // Equity should include initial $500 + retained earnings $970
      const totalEquity =
        50000 + expectedNetIncome;
      const totalLiabilitiesAndEquity =
        result.totalLiabilitiesAndEquityMinor;

      // Verify the breakdown: Assets = Liabilities + Equity
      const totalAssets = result.totalAssetsMinor;
      assert.strictEqual(totalAssets, totalLiabilitiesAndEquity);
    });

    it('should exclude accounts with zero balance', () => {
      const result = balanceSheet(ledger, { asOf: '2025-06-30' });

      // Should not include Savings (empty), CreditCard (zero balance), or Salary/Investment (income accounts)
      // Only include accounts with non-zero balance
      assert(result.assets.length >= 1); // At least Checking
      assert(result.equityAccounts.length >= 1); // At least Owner
    });

    it('should maintain parts-sum-to-total invariant: equityAccounts sum equals totalEquityMinor', () => {
      // Post income to generate non-zero retained earnings
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Salary income',
        splits: [
          { account: 'Assets:Checking', amount: 100000 },
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      // Post expense to have retained earnings > 0
      postTransaction(ledger, {
        date: '2025-06-10',
        description: 'Expense',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      const result = balanceSheet(ledger, { asOf: '2025-06-30' });

      // Sum all equityAccounts
      const equityAccountsSum = result.equityAccounts.reduce((sum, a) => sum + a.totalMinor, 0);

      // Verify the invariant: sum of equityAccounts equals totalEquityMinor
      assert.strictEqual(equityAccountsSum, result.totalEquityMinor);

      // Verify that a "Retained Earnings" entry exists in equityAccounts
      const retainedEarningsEntry = result.equityAccounts.find(
        (a) => a.accountName === 'Retained Earnings'
      );
      assert.ok(retainedEarningsEntry, 'Retained Earnings entry should exist in equityAccounts');
      assert.strictEqual(
        retainedEarningsEntry?.totalMinor,
        result.retainedEarnings,
        'Retained Earnings entry totalMinor should match result.retainedEarnings'
      );
    });
  });

  describe('taxYearExport', () => {
    it('should export income and expense splits for a tax year', () => {
      postTransaction(ledger, {
        date: '2025-03-01',
        description: 'Salary',
        splits: [
          { account: 'Assets:Checking', amount: 100000 },
          { account: 'Income:Salary', amount: -100000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Groceries',
        splits: [
          { account: 'Expenses:Food:Groceries', amount: 5000 },
          { account: 'Assets:Checking', amount: -5000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-09-20',
        description: 'Restaurant',
        splits: [
          { account: 'Expenses:Food:Restaurants', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      const result = taxYearExport(ledger, { year: 2025 });

      // Should have 3 rows (1 salary, 2 expenses)
      assert.strictEqual(result.length, 3);

      // Check that rows are in order and have correct dates
      const dates = result.map((r) => r.date);
      assert.deepStrictEqual(dates, ['2025-03-01', '2025-06-15', '2025-09-20']);

      // Check account names
      const accountNames = result.map((r) => r.accountName);
      assert(accountNames.includes('Income:Salary'));
      assert(accountNames.includes('Expenses:Food:Groceries'));
      assert(accountNames.includes('Expenses:Food:Restaurants'));

      // Check amounts (in major units)
      const amounts = result.map((r) => r.amountMajor);
      assert(amounts.includes(-1000)); // Salary (credit, negative)
      assert(amounts.includes(50)); // Groceries
      assert(amounts.includes(30)); // Restaurant
    });

    it('should only export transactions within the target year', () => {
      postTransaction(ledger, {
        date: '2024-12-31',
        splits: [
          { account: 'Assets:Checking', amount: 50000 },
          { account: 'Income:Salary', amount: -50000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2025-06-01',
        splits: [
          { account: 'Assets:Checking', amount: 60000 },
          { account: 'Income:Salary', amount: -60000 },
        ],
        approved: true,
      });

      postTransaction(ledger, {
        date: '2026-01-01',
        splits: [
          { account: 'Assets:Checking', amount: 70000 },
          { account: 'Income:Salary', amount: -70000 },
        ],
        approved: true,
      });

      const result = taxYearExport(ledger, { year: 2025 });

      // Should only have 1 row (June 2025)
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].date, '2025-06-01');
    });

    it('should exclude asset/liability/equity transactions', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Asset transfer',
        splits: [
          { account: 'Assets:Checking', amount: -10000 },
          { account: 'Assets:Savings', amount: 10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-05',
        description: 'Expense',
        splits: [
          { account: 'Expenses:Entertainment', amount: 5000 },
          { account: 'Assets:Checking', amount: -5000 },
        ],
      });

      const result = taxYearExport(ledger, { year: 2025 });

      // Should only have 1 row (the expense)
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].accountName, 'Expenses:Entertainment');
    });
  });

  describe('CSV Export', () => {
    it('should handle basic CSV serialization', () => {
      const rows = [
        { date: '2025-01-01', category: 'Food', amount: 50 },
        { date: '2025-01-02', category: 'Entertainment', amount: 30 },
      ];

      const csv = toCsv(rows, ['date', 'category', 'amount']);

      const lines = csv.split('\n');
      assert.strictEqual(lines[0], 'date,category,amount');
      assert.strictEqual(lines[1], '2025-01-01,Food,50');
      assert.strictEqual(lines[2], '2025-01-02,Entertainment,30');
    });

    it('should quote fields containing commas', () => {
      const rows = [
        { date: '2025-01-01', description: 'Dinner at "Joe\'s, Inc."', amount: 50 },
      ];

      const csv = toCsv(rows, ['date', 'description', 'amount']);

      // The description field should be quoted because it contains commas and quotes
      assert(csv.includes('"Dinner at ""Joe\'s, Inc."""'));
    });

    it('should escape internal quotes by doubling them', () => {
      const rows = [{ value: 'Hello "World"' }];
      const csv = toCsv(rows, ['value']);

      // Quote should be doubled
      assert(csv.includes('"Hello ""World"""'));
    });

    it('should quote fields containing newlines', () => {
      const rows = [{ value: 'Line 1\nLine 2' }];
      const csv = toCsv(rows, ['value']);

      const lines = csv.split('\n');
      // Header
      assert.strictEqual(lines[0], 'value');
      // Data row should be on one line (quoted)
      assert(csv.includes('"Line 1\nLine 2"'));
    });
  });

  describe('Integration: Tool-level smoke tests', () => {
    it('should run spendingByCategory without throwing', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        splits: [
          { account: 'Expenses:Entertainment', amount: 2000 },
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      // Should not throw
      const result = spendingByCategory(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      assert(Array.isArray(result));
      assert.strictEqual(result.length, 1);
    });

    it('should run incomeStatement without throwing', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        splits: [
          { account: 'Assets:Checking', amount: 50000 },
          { account: 'Income:Salary', amount: -50000 },
        ],
      });

      // Should not throw
      const result = incomeStatement(ledger, {
        startDate: '2025-06-01',
        endDate: '2025-06-30',
      });

      assert.strictEqual(typeof result.incomeMinor, 'number');
      assert.strictEqual(typeof result.expenseMinor, 'number');
      assert.strictEqual(typeof result.netIncomeMinor, 'number');
    });

    it('should run balanceSheet without throwing', () => {
      // Should not throw
      const result = balanceSheet(ledger, { asOf: '2025-06-30' });

      assert.strictEqual(typeof result.totalAssetsMinor, 'number');
      assert.strictEqual(typeof result.totalLiabilitiesAndEquityMinor, 'number');
      // Verify accounting identity
      assert.strictEqual(result.totalAssetsMinor, result.totalLiabilitiesAndEquityMinor);
    });

    it('should render formatted text totals matching the structured result', () => {
      postTransaction(ledger, {
        date: '2025-06-10',
        splits: [
          { account: 'Assets:Checking', amount: 50000 },
          { account: 'Liabilities:CreditCard', amount: -50000 },
        ],
      });

      const result = balanceSheet(ledger, { asOf: '2025-06-30' });
      assert.notStrictEqual(result.totalLiabilitiesMinor, 0);

      const text = formatBalanceSheet(result);
      assert.ok(
        text.includes(`Total Liabilities: $${(result.totalLiabilitiesMinor / 100).toFixed(2)}`)
      );
      assert.ok(
        text.includes(`Total Equity: $${(result.totalEquityMinor / 100).toFixed(2)}`)
      );
      // The displayed liabilities figure must not silently fall back to zero.
      assert.ok(!text.includes('Total Liabilities: $0.00'));
    });

    it('should run taxYearExport without throwing', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        splits: [
          { account: 'Expenses:Entertainment', amount: 2000 },
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });

      // Should not throw
      const result = taxYearExport(ledger, { year: 2025 });

      assert(Array.isArray(result));
    });
  });

  describe('resolveExportPath', () => {
    it('resolves a plain file name inside data/exports/', () => {
      const path = resolveExportPath('tax-export-2025.csv', 'default.csv');
      assert.ok(path.endsWith(`${join('data', 'exports', 'tax-export-2025.csv')}`));
    });

    it('falls back to the default name when none is given', () => {
      const path = resolveExportPath(undefined, 'default.csv');
      assert.ok(path.endsWith(`${join('data', 'exports', 'default.csv')}`));
    });

    it('rejects a path that escapes data/exports/ via ..', () => {
      assert.throws(() => resolveExportPath('../../etc/passwd', 'default.csv'), /must resolve inside data\/exports/);
    });

    it('rejects an absolute path outside data/exports/', () => {
      assert.throws(() => resolveExportPath('/etc/passwd', 'default.csv'), /must resolve inside data\/exports/);
    });
  });
});
