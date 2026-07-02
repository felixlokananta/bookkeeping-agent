/**
 * Unit tests for the reconciliation extension.
 * Run with: npm test
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  diffStatementBalance,
  listUnreconciledSplits,
  matchStatementToLedger,
  reconcileAccount,
  type StatementRow,
} from '../.pi/extensions/reconciliation/reconcile.ts';
import { verifyLedger } from '../.pi/extensions/reconciliation/verify.ts';

describe('Reconciliation Extension Tests', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    // Isolate anomaly-log writes and vendor rules from the real memory/ files
    tmpDir = mkdtempSync(join(tmpdir(), 'reconciliation-test-'));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, 'vendor_rules.json');
  });

  after(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    delete process.env.BOOKKEEPING_VENDOR_RULES_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up env
    delete process.env.BOOKKEEPING_DB_PATH;

    // Open in-memory ledger
    ledger = openLedger(':memory:');

    // Create necessary accounts
    createAccount(ledger, { name: 'Assets:Checking' });
    createAccount(ledger, { name: 'Expenses:Groceries' });
    createAccount(ledger, { name: 'Income:Salary' });
  });

  afterEach(() => {
    if (ledger) {
      closeLedger(ledger);
    }
  });

  describe('diffStatementBalance', () => {
    it('should return zero discrepancy when balances match', () => {
      // Post a transaction: +$100 income
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 10000 }, // +$100
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const result = diffStatementBalance(ledger, {
        account: 'Assets:Checking',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 10000, // Statement shows +$100
      });

      assert.strictEqual(result.ledgerNaturalMinor, 10000);
      assert.strictEqual(result.statementBalanceMinor, 10000);
      assert.strictEqual(result.discrepancyMinor, 0);
    });

    it('should return correct signed discrepancy when ledger is higher', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 15000 }, // +$150
          { account: 'Income:Salary', amount: -15000 },
        ],
      });

      const result = diffStatementBalance(ledger, {
        account: 'Assets:Checking',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 10000, // Statement shows +$100
      });

      assert.strictEqual(result.ledgerNaturalMinor, 15000);
      assert.strictEqual(result.statementBalanceMinor, 10000);
      assert.strictEqual(result.discrepancyMinor, 5000); // Ledger high by $50
    });

    it('should return correct signed discrepancy when statement is higher', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 5000 }, // +$50
          { account: 'Income:Salary', amount: -5000 },
        ],
      });

      const result = diffStatementBalance(ledger, {
        account: 'Assets:Checking',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 10000, // Statement shows +$100
      });

      assert.strictEqual(result.ledgerNaturalMinor, 5000);
      assert.strictEqual(result.statementBalanceMinor, 10000);
      assert.strictEqual(result.discrepancyMinor, -5000); // Statement high by $50
    });
  });

  describe('listUnreconciledSplits', () => {
    it('should exclude splits with existing reconciliations rows', () => {
      // Post two transactions
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Groceries',
        splits: [
          { account: 'Assets:Checking', amount: -3000 },
          { account: 'Expenses:Groceries', amount: 3000 },
        ],
      });

      // Manually insert a reconciliation_runs row and a reconciliations row for the first split
      ledger.db.exec('BEGIN IMMEDIATE');
      const runResult = ledger.db
        .prepare(
          `INSERT INTO reconciliation_runs (account_id, period_start, period_end, statement_balance_minor, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(1, '2025-06-01', '2025-06-30', 10000, Date.now());
      const runId = runResult.lastInsertRowid as number;

      // Get first split id (should be 1)
      ledger.db
        .prepare(
          `INSERT INTO reconciliations (run_id, split_id, created_at)
           VALUES (?, ?, ?)`
        )
        .run(runId, 1, Date.now());
      ledger.db.exec('COMMIT');

      // List unreconciled splits
      const unreconciled = listUnreconciledSplits(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
      });

      // Should have only 1 unreconciled split (the second transaction's split for Assets:Checking)
      // Split 1 was reconciled, so only split 3 (from the second transaction) remains
      assert.strictEqual(unreconciled.length, 1);
      assert.strictEqual(unreconciled[0].splitId, 3);
    });

    it('should include all splits when no reconciliations exist', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Groceries',
        splits: [
          { account: 'Assets:Checking', amount: -3000 },
          { account: 'Expenses:Groceries', amount: 3000 },
        ],
      });

      const unreconciled = listUnreconciledSplits(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
      });

      // Should have 2 splits for Assets:Checking
      assert.strictEqual(unreconciled.length, 2);
    });
  });

  describe('matchStatementToLedger', () => {
    it('should match Tier 1: exact amount within windowDays', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-15', description: 'Employer deposit', amountMinor: 10000 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3,
      });

      assert.strictEqual(result.matched.length, 1);
      assert.strictEqual(result.matched[0].statementRow.description, 'Employer deposit');
      assert.strictEqual(result.ledgerOnly.length, 0);
      assert.strictEqual(result.statementOnly.length, 0);
    });

    it('should not match Tier 1 when date is outside windowDays', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-10', description: 'Employer deposit', amountMinor: 10000 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3, // +/- 3 days from 2025-06-10 is 2025-06-07 to 2025-06-13; 2025-06-01 is outside
      });

      assert.strictEqual(result.matched.length, 0);
      assert.strictEqual(result.ledgerOnly.length, 1);
      assert.strictEqual(result.statementOnly.length, 1);
    });

    it('should fall back to Tier 2: exact amount + fuzzy description match when Tier 1 fails on date', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'EMPLOYER DEPOSIT',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-10', description: 'Employer Direct Deposit', amountMinor: 10000 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3,
      });

      // Should match via Tier 2 (fuzzy match)
      assert.strictEqual(result.matched.length, 1);
      assert.strictEqual(result.matched[0].statementRow.description, 'Employer Direct Deposit');
      assert.strictEqual(result.ledgerOnly.length, 0);
      assert.strictEqual(result.statementOnly.length, 0);
    });

    it('should not match Tier 2 when descriptions do not match', () => {
      postTransaction(ledger, {
        date: '2025-06-01',
        description: 'Grocery store',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Expenses:Groceries', amount: -10000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-10', description: 'Salary payment', amountMinor: 10000 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3,
      });

      // No match (different descriptions, different amount conceptually)
      assert.strictEqual(result.matched.length, 0);
      assert.strictEqual(result.ledgerOnly.length, 1);
      assert.strictEqual(result.statementOnly.length, 1);
    });

    it('should surface ledger-only and statement-only entries when counts differ', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Income',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Expense',
        splits: [
          { account: 'Assets:Checking', amount: -3000 },
          { account: 'Expenses:Groceries', amount: 3000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-15', description: 'Income', amountMinor: 10000 },
        // Missing the 2025-06-20 expense and has an extra statement entry
        { date: '2025-06-25', description: 'Fee', amountMinor: -500 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3,
      });

      assert.strictEqual(result.matched.length, 1);
      assert.strictEqual(result.ledgerOnly.length, 1); // The 2025-06-20 expense
      assert.strictEqual(result.statementOnly.length, 1); // The 2025-06-25 fee
    });
  });

  describe('Cross-source annotation', () => {
    it('should flag matched transactions with source_path as sourcedFromReceipt', () => {
      // Post a transaction from receipt capture (with source_path)
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Restaurant receipt',
        splits: [
          { account: 'Assets:Checking', amount: -5000 },
          { account: 'Expenses:Groceries', amount: 5000 },
        ],
        sourcePath: 'data/receipts/restaurant_2025-06-15.png',
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-15', description: 'Restaurant', amountMinor: -5000 },
      ];

      const result = matchStatementToLedger(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementRows,
        windowDays: 3,
      });

      assert.strictEqual(result.matched.length, 1);
      assert.strictEqual(result.matched[0].sourcedFromReceipt, true);
      assert.strictEqual(result.matched[0].receiptPath, 'data/receipts/restaurant_2025-06-15.png');
    });
  });

  describe('reconcileAccount', () => {
    it('should not write to reconciliations when markReconciled is false', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Income',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-15', description: 'Income', amountMinor: 10000 },
      ];

      const result = reconcileAccount(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 10000,
        statementRows,
        markReconciled: false,
      });

      // Should not have a runId
      assert.strictEqual(result.runId, undefined);

      // Verify no reconciliation_runs row was written
      const runCount = ledger.db
        .prepare('SELECT COUNT(*) as count FROM reconciliation_runs')
        .get() as { count: number };
      assert.strictEqual(runCount.count, 0);

      // Verify no reconciliations row was written
      const reconCount = ledger.db
        .prepare('SELECT COUNT(*) as count FROM reconciliations')
        .get() as { count: number };
      assert.strictEqual(reconCount.count, 0);
    });

    it('should write exactly one run row and one row per matched split when markReconciled is true', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Income',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Expense',
        splits: [
          { account: 'Assets:Checking', amount: -3000 },
          { account: 'Expenses:Groceries', amount: 3000 },
        ],
      });

      const statementRows: StatementRow[] = [
        { date: '2025-06-15', description: 'Income', amountMinor: 10000 },
        { date: '2025-06-20', description: 'Expense', amountMinor: -3000 },
      ];

      const result = reconcileAccount(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 7000, // 10000 - 3000
        statementRows,
        markReconciled: true,
      });

      // Should have a runId
      assert.ok(result.runId);

      // Verify exactly one reconciliation_runs row
      const runCount = ledger.db
        .prepare('SELECT COUNT(*) as count FROM reconciliation_runs')
        .get() as { count: number };
      assert.strictEqual(runCount.count, 1);

      // Verify exactly 2 reconciliations rows (one per matched split)
      const reconCount = ledger.db
        .prepare('SELECT COUNT(*) as count FROM reconciliations')
        .get() as { count: number };
      assert.strictEqual(reconCount.count, 2);
    });
  });

  describe('Re-running after marking reconciled', () => {
    it('should exclude already-reconciled splits from next unreconciled listing', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Income',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Expense',
        splits: [
          { account: 'Assets:Checking', amount: -3000 },
          { account: 'Expenses:Groceries', amount: 3000 },
        ],
      });

      // First reconciliation with only first entry
      const statementRows1: StatementRow[] = [
        { date: '2025-06-15', description: 'Income', amountMinor: 10000 },
      ];

      reconcileAccount(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 10000,
        statementRows: statementRows1,
        markReconciled: true,
      });

      // Second reconciliation with both entries
      const statementRows2: StatementRow[] = [
        { date: '2025-06-15', description: 'Income', amountMinor: 10000 },
        { date: '2025-06-20', description: 'Expense', amountMinor: -3000 },
      ];

      const result2 = reconcileAccount(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 7000,
        statementRows: statementRows2,
        markReconciled: false, // Just preview
      });

      // Should match only the second statement row to the second transaction
      // The first statement row (amount 10000) won't match split 3 (amount -3000)
      assert.strictEqual(result2.matches.matched.length, 1);
      assert.strictEqual(result2.matches.matched[0].transactionId, 2); // Second transaction
      assert.strictEqual(result2.matches.ledgerOnly.length, 0); // All ledger splits are reconciled or matched
      assert.strictEqual(result2.matches.statementOnly.length, 1); // First statement row has no match
    });
  });

  describe('verifyLedger', () => {
    it('should detect unbalanced transactions', () => {
      // Manually insert an unbalanced transaction (bypassing postTransaction validation)
      ledger.db.exec('BEGIN IMMEDIATE');
      const txResult = ledger.db
        .prepare(
          `INSERT INTO transactions (date, description, created_at)
           VALUES (?, ?, ?)`
        )
        .run('2025-06-15', 'Unbalanced transaction', Date.now());
      const txId = Number(txResult.lastInsertRowid);

      // Insert only one split (unbalanced)
      ledger.db
        .prepare(
          `INSERT INTO splits (transaction_id, account_id, amount)
           VALUES (?, ?, ?)`
        )
        .run(txId, 1, 10000); // Only one split, imbalanced

      ledger.db.exec('COMMIT');

      const result = verifyLedger(ledger);

      assert.strictEqual(result.unbalancedTransactions.length, 1);
      assert.strictEqual(result.unbalancedTransactions[0].transactionId, txId);
      assert.strictEqual(result.unbalancedTransactions[0].sumAmount, 10000);
    });

    it('should return zero issues for a clean ledger', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Clean transaction',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      const result = verifyLedger(ledger);

      assert.strictEqual(result.unbalancedTransactions.length, 0);
      assert.strictEqual(result.orphanSplits.length, 0);
      assert.strictEqual(result.trialBalanceOk, true);
      assert.strictEqual(result.trialBalanceMinor, 0);
      assert.strictEqual(result.unexpectedSignAccounts.length, 0);
    });

    it('should compute trial balance correctly', () => {
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'First',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Second',
        splits: [
          { account: 'Assets:Checking', amount: 5000 },
          { account: 'Income:Salary', amount: -5000 },
        ],
      });

      const result = verifyLedger(ledger);

      // Trial balance should be zero (balanced ledger)
      assert.strictEqual(result.trialBalanceMinor, 0);
      assert.strictEqual(result.trialBalanceOk, true);
    });

    it('should flag accounts with unexpected-sign balances', () => {
      // Post transactions that create unexpected balances:
      // - Assets:Checking is debit-normal, -10000 makes it negative (unexpected)
      // - Income:Salary is credit-normal, +10000 raw is -10000 natural (unexpected, should be positive)
      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Withdrawal',
        splits: [
          { account: 'Assets:Checking', amount: -10000 }, // Negative in debit-normal
          { account: 'Income:Salary', amount: 10000 },    // Negative natural in credit-normal
        ],
      });

      const result = verifyLedger(ledger);

      // Both accounts should have unexpected signs
      assert.strictEqual(result.unexpectedSignAccounts.length, 2);

      // Find the Assets:Checking entry
      const checkingUnexpected = result.unexpectedSignAccounts.find(
        (a) => a.accountName === 'Assets:Checking'
      );
      assert.ok(checkingUnexpected);
      assert.strictEqual(checkingUnexpected.signMismatch, 'negative_in_debit_account');

      // Find the Income:Salary entry
      const incomeUnexpected = result.unexpectedSignAccounts.find(
        (a) => a.accountName === 'Income:Salary'
      );
      assert.ok(incomeUnexpected);
      assert.strictEqual(incomeUnexpected.signMismatch, 'positive_in_credit_account');
    });
  });

  describe('CSV statement parsing integration', () => {
    it('should parse CSV statement and match entries correctly', () => {
      // Create a small CSV fixture
      const csvContent = `date,description,amount
2025-06-15,Employer Deposit,100.00
2025-06-20,Grocery Store,-50.00`;

      const csvPath = join(tmpDir, 'statement.csv');
      writeFileSync(csvPath, csvContent);

      postTransaction(ledger, {
        date: '2025-06-15',
        description: 'Salary deposit',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Income:Salary', amount: -10000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-06-20',
        description: 'Grocery store',
        splits: [
          { account: 'Assets:Checking', amount: -5000 },
          { account: 'Expenses:Groceries', amount: 5000 },
        ],
      });

      const result = reconcileAccount(ledger, {
        account: 'Assets:Checking',
        periodStart: '2025-06-01',
        periodEnd: '2025-06-30',
        statementBalanceMinor: 4500, // 100.00 * 100 - 50.00 * 100
        statementPath: csvPath,
        markReconciled: false,
      });

      // Both entries should match
      assert.strictEqual(result.matches.matched.length, 2);
      assert.strictEqual(result.matches.ledgerOnly.length, 0);
      assert.strictEqual(result.matches.statementOnly.length, 0);
    });
  });
});
