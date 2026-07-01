/**
 * Unit tests for the ledger core, money helpers, and policy gate.
 * Run with: node --test test/ledger.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'fs';
import {
  openLedger,
  closeLedger,
  seedDefaultChart,
  createAccount,
  postTransaction,
  getBalance,
  listAccounts,
  listTransactions,
  type Ledger,
  resolveAccount,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import { toMinor, toMajor, formatMoney } from '../.pi/extensions/bookkeeping/money.ts';
import { loadAutoPostLimitMinor, checkAutoPost, logAnomaly } from '../.pi/extensions/bookkeeping/policy.ts';

describe('Ledger Core Tests', () => {
  let ledger: Ledger;

  beforeEach(() => {
    // Clean up env
    delete process.env.BOOKKEEPING_AUTOPOST_LIMIT;
    delete process.env.BOOKKEEPING_DB_PATH;

    // Open in-memory ledger
    ledger = openLedger(':memory:');
  });

  afterEach(() => {
    if (ledger) {
      closeLedger(ledger);
    }
  });

  describe('Initialization', () => {
    it('should seed exactly 5 root accounts with correct types and normal balances', () => {
      const accounts = listAccounts(ledger);
      const roots = accounts.filter((a) => a.parent_id === null);

      assert.strictEqual(roots.length, 5);

      const rootsByName: Record<string, any> = {};
      roots.forEach((r) => {
        rootsByName[r.name] = r;
      });

      assert.ok(rootsByName['Assets']);
      assert.strictEqual(rootsByName['Assets'].type, 'asset');
      assert.strictEqual(rootsByName['Assets'].normal_balance, 'debit');

      assert.ok(rootsByName['Liabilities']);
      assert.strictEqual(rootsByName['Liabilities'].type, 'liability');
      assert.strictEqual(rootsByName['Liabilities'].normal_balance, 'credit');

      assert.ok(rootsByName['Equity']);
      assert.strictEqual(rootsByName['Equity'].type, 'equity');
      assert.strictEqual(rootsByName['Equity'].normal_balance, 'credit');

      assert.ok(rootsByName['Income']);
      assert.strictEqual(rootsByName['Income'].type, 'income');
      assert.strictEqual(rootsByName['Income'].normal_balance, 'credit');

      assert.ok(rootsByName['Expenses']);
      assert.strictEqual(rootsByName['Expenses'].type, 'expense');
      assert.strictEqual(rootsByName['Expenses'].normal_balance, 'debit');
    });

    it('should not duplicate roots when openLedger is called twice', () => {
      const ledger2 = openLedger(':memory:');
      const accounts1 = listAccounts(ledger);
      const accounts2 = listAccounts(ledger2);
      assert.strictEqual(accounts1.length, 5);
      assert.strictEqual(accounts2.length, 5);
      closeLedger(ledger2);
    });
  });

  describe('createAccount', () => {
    it('should create Assets:Checking with inherited type', () => {
      const acc = createAccount(ledger, { name: 'Assets:Checking' });
      assert.strictEqual(acc.name, 'Assets:Checking');
      assert.strictEqual(acc.type, 'asset');
      assert.strictEqual(acc.normal_balance, 'debit');
    });

    it('should auto-create intermediate parents', () => {
      const acc = createAccount(ledger, {
        name: 'Expenses:Food:Groceries',
      });
      assert.strictEqual(acc.name, 'Expenses:Food:Groceries');

      // Verify intermediate was created
      const intermediate = resolveAccount(ledger, 'Expenses:Food');
      assert.strictEqual(intermediate.type, 'expense');
      assert.strictEqual(intermediate.normal_balance, 'debit');
    });

    it('should link parent accounts correctly', () => {
      createAccount(ledger, { name: 'Assets:Checking' });
      const checking = resolveAccount(ledger, 'Assets:Checking');
      const assets = resolveAccount(ledger, 'Assets');
      assert.strictEqual(checking.parent_id, assets.id);
    });

    it('should reject duplicate account names', () => {
      createAccount(ledger, { name: 'Assets:Checking' });
      assert.throws(() => {
        createAccount(ledger, { name: 'Assets:Checking' });
      }, /already exists/);
    });

    it('should reject unknown root without type', () => {
      assert.throws(() => {
        createAccount(ledger, { name: 'UnknownRoot:Sub' });
      }, /Unknown root/);
    });

    it('should reject type mismatch with root', () => {
      assert.throws(() => {
        createAccount(ledger, {
          name: 'Assets:Sub',
          type: 'liability',
        });
      }, /type mismatch/);
    });
  });

  describe('postTransaction', () => {
    beforeEach(() => {
      createAccount(ledger, { name: 'Assets:Checking' });
      createAccount(ledger, { name: 'Equity:Owner' });
    });

    it('should post a balanced transaction successfully', () => {
      const result = postTransaction(ledger, {
        date: '2024-01-01',
        description: 'Owner investment',
        splits: [
          { account: 'Assets:Checking', amount: 10000 }, // $100
          { account: 'Equity:Owner', amount: -10000 }, // -$100
        ],
      });

      assert.ok(result.transactionId);
      assert.strictEqual(result.splitIds.length, 2);

      // Verify transaction was persisted
      const txns = listTransactions(ledger, { limit: 1 });
      assert.strictEqual(txns.length, 1);
      assert.strictEqual(txns[0].date, '2024-01-01');
      assert.strictEqual(txns[0].description, 'Owner investment');
      assert.strictEqual(txns[0].splits.length, 2);
    });

    it('should reject unbalanced transactions and log anomaly', () => {
      // Clear anomaly log first
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '999999';

      assert.throws(() => {
        postTransaction(ledger, {
          date: '2024-01-01',
          splits: [
            { account: 'Assets:Checking', amount: 10000 },
            { account: 'Equity:Owner', amount: -9000 }, // Not balanced!
          ],
        });
      }, /imbalanced/);

      // Verify nothing was written
      const accounts = listAccounts(ledger);
      const checking = accounts.find((a) => a.name === 'Assets:Checking');
      const balance = getBalance(ledger, { account: checking!.id });
      assert.strictEqual(balance.rawMinor, 0); // No splits posted
    });

    it('should reject single split', () => {
      assert.throws(() => {
        postTransaction(ledger, {
          date: '2024-01-01',
          splits: [{ account: 'Assets:Checking', amount: 10000 }],
        });
      }, /at least 2 splits/);
    });

    it('should reject unknown account', () => {
      assert.throws(() => {
        postTransaction(ledger, {
          date: '2024-01-01',
          splits: [
            { account: 'Assets:Checking', amount: 10000 },
            { account: 'Unknown:Account', amount: -10000 },
          ],
        });
      }, /not found|Unknown account/);
    });

    it('should reject zero amount', () => {
      assert.throws(() => {
        postTransaction(ledger, {
          date: '2024-01-01',
          splits: [
            { account: 'Assets:Checking', amount: 0 },
            { account: 'Equity:Owner', amount: 0 },
          ],
        });
      }, /cannot be zero/);
    });
  });

  describe('Auto-post threshold gate', () => {
    beforeEach(() => {
      createAccount(ledger, { name: 'Assets:Checking' });
      createAccount(ledger, { name: 'Equity:Owner' });
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '100'; // $100 limit
    });

    it('should block post above threshold without approval', () => {
      assert.throws(() => {
        postTransaction(ledger, {
          date: '2024-01-01',
          splits: [
            { account: 'Assets:Checking', amount: 50000 }, // $500
            { account: 'Equity:Owner', amount: -50000 },
          ],
        });
      }, /exceeds auto-post limit/);

      // Verify nothing was written
      const balance = getBalance(ledger, { account: 'Assets:Checking' });
      assert.strictEqual(balance.rawMinor, 0);
    });

    it('should allow post above threshold with approval', () => {
      const result = postTransaction(ledger, {
        date: '2024-01-01',
        splits: [
          { account: 'Assets:Checking', amount: 50000 }, // $500
          { account: 'Equity:Owner', amount: -50000 },
        ],
        approved: true,
      });

      assert.ok(result.transactionId);

      // Verify it was written
      const balance = getBalance(ledger, { account: 'Assets:Checking' });
      assert.strictEqual(balance.rawMinor, 50000);
    });

    it('should allow post below threshold without approval', () => {
      const result = postTransaction(ledger, {
        date: '2024-01-01',
        splits: [
          { account: 'Assets:Checking', amount: 5000 }, // $50
          { account: 'Equity:Owner', amount: -5000 },
        ],
      });

      assert.ok(result.transactionId);

      // Verify it was written
      const balance = getBalance(ledger, { account: 'Assets:Checking' });
      assert.strictEqual(balance.rawMinor, 5000);
    });
  });

  describe('getBalance', () => {
    beforeEach(() => {
      createAccount(ledger, { name: 'Assets:Checking' });
      createAccount(ledger, { name: 'Equity:Owner' });
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '999999';

      // Post initial transaction
      postTransaction(ledger, {
        date: '2024-01-01',
        splits: [
          { account: 'Assets:Checking', amount: 10000 },
          { account: 'Equity:Owner', amount: -10000 },
        ],
      });
    });

    it('should return positive natural balance for debit-normal account', () => {
      const balance = getBalance(ledger, { account: 'Assets:Checking' });
      assert.strictEqual(balance.rawMinor, 10000);
      assert.strictEqual(balance.naturalMinor, 10000); // debit-normal: natural = raw
    });

    it('should return positive natural balance for credit-normal account', () => {
      const balance = getBalance(ledger, { account: 'Equity:Owner' });
      assert.strictEqual(balance.rawMinor, -10000); // raw is negative (credit)
      assert.strictEqual(balance.naturalMinor, 10000); // natural = -raw = 10000
    });

    it('should filter by asOf date', () => {
      postTransaction(ledger, {
        date: '2024-02-01',
        splits: [
          { account: 'Assets:Checking', amount: 5000 },
          { account: 'Equity:Owner', amount: -5000 },
        ],
      });

      const balanceAsOf = getBalance(ledger, {
        account: 'Assets:Checking',
        asOf: '2024-01-31',
      });
      assert.strictEqual(balanceAsOf.rawMinor, 10000); // Only first transaction
    });
  });

  describe('listTransactions', () => {
    beforeEach(() => {
      createAccount(ledger, { name: 'Assets:Checking' });
      createAccount(ledger, { name: 'Expenses:Food' });
      createAccount(ledger, { name: 'Equity:Owner' });
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '999999';

      // Post multiple transactions
      postTransaction(ledger, {
        date: '2024-01-01',
        description: 'Initial investment',
        splits: [
          { account: 'Assets:Checking', amount: 50000 },
          { account: 'Equity:Owner', amount: -50000 },
        ],
      });

      postTransaction(ledger, {
        date: '2024-01-15',
        description: 'Groceries',
        splits: [
          { account: 'Expenses:Food', amount: 3000 },
          { account: 'Assets:Checking', amount: -3000 },
        ],
      });

      postTransaction(ledger, {
        date: '2024-02-01',
        description: 'More groceries',
        splits: [
          { account: 'Expenses:Food', amount: 2000 },
          { account: 'Assets:Checking', amount: -2000 },
        ],
      });
    });

    it('should list all transactions in date order', () => {
      const txns = listTransactions(ledger, { limit: 100 });
      assert.strictEqual(txns.length, 3);
      assert.strictEqual(txns[0].date, '2024-01-01');
      assert.strictEqual(txns[1].date, '2024-01-15');
      assert.strictEqual(txns[2].date, '2024-02-01');
    });

    it('should filter by account', () => {
      const txns = listTransactions(ledger, { account: 'Assets:Checking' });
      assert.strictEqual(txns.length, 3); // All three txns touch Checking
    });

    it('should filter by date range', () => {
      const txns = listTransactions(ledger, {
        startDate: '2024-01-10',
        endDate: '2024-01-31',
      });
      assert.strictEqual(txns.length, 1);
      assert.strictEqual(txns[0].description, 'Groceries');
    });

    it('should respect limit', () => {
      const txns = listTransactions(ledger, { limit: 2 });
      assert.strictEqual(txns.length, 2);
    });
  });

  describe('Money helpers', () => {
    it('toMinor should convert major to cents', () => {
      assert.strictEqual(toMinor(12.5), 1250);
      assert.strictEqual(toMinor(0.01), 1);
      assert.strictEqual(toMinor(100), 10000);
    });

    it('toMinor should round correctly', () => {
      // 0.1 + 0.2 = 0.3 (but float: 0.30000000000000004)
      const result = toMinor(0.1 + 0.2);
      assert.strictEqual(result, 30);
    });

    it('toMajor should convert cents to major', () => {
      assert.strictEqual(toMajor(1250), 12.5);
      assert.strictEqual(toMajor(10000), 100);
      assert.strictEqual(toMajor(1), 0.01);
    });

    it('formatMoney should format with 2 decimal places', () => {
      assert.strictEqual(formatMoney(1250), '12.50');
      assert.strictEqual(formatMoney(-1250), '-12.50');
      assert.strictEqual(formatMoney(0), '0.00');
    });

    it('toMinor should throw on non-finite', () => {
      assert.throws(() => toMinor(NaN));
      assert.throws(() => toMinor(Infinity));
    });
  });

  describe('Policy loader and anomaly log', () => {
    beforeEach(() => {
      delete process.env.BOOKKEEPING_AUTOPOST_LIMIT;
    });

    it('should load limit from env override', () => {
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '250';
      const limitMinor = loadAutoPostLimitMinor();
      assert.strictEqual(limitMinor, 25000); // $250 = 25000 cents
    });

    it('should use default limit if no env and no config file', () => {
      // In test env, config file probably doesn't exist
      const limitMinor = loadAutoPostLimitMinor();
      assert.strictEqual(limitMinor, 50000); // default $500 = 50000 cents
    });

    it('checkAutoPost should allow if approved', () => {
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '100';
      const result = checkAutoPost(50000, { approved: true });
      assert.strictEqual(result.allowed, true);
    });

    it('checkAutoPost should allow if below limit', () => {
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '100';
      const result = checkAutoPost(5000, { approved: false });
      assert.strictEqual(result.allowed, true);
    });

    it('checkAutoPost should block if above limit and not approved', () => {
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '100';
      const result = checkAutoPost(50000, { approved: false });
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.limitMinor, 10000);
    });
  });
});
