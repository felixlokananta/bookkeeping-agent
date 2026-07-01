/**
 * Unit tests for the categorization extension.
 * Run with: npm test
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openLedger,
  closeLedger,
  postTransaction,
  createAccount,
  type Ledger,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import {
  listUncategorized,
  suggestCategory,
  applyCategory,
  bulkRecategorize,
} from '../.pi/extensions/categorization/categorize.ts';
import {
  normalizePayee,
  matchRule,
  loadRules,
  saveRules,
  upsertRule,
  extractVendorPattern,
  type Rules,
} from '../.pi/extensions/categorization/rules.ts';

describe('Categorization Extension Tests', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    // Isolate vendor_rules.json and anomaly_log.json writes from the real memory/ files
    tmpDir = mkdtempSync(join(tmpdir(), 'categorization-test-'));
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, 'vendor_rules.json');
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
  });

  after(() => {
    delete process.env.BOOKKEEPING_VENDOR_RULES_PATH;
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up env
    delete process.env.BOOKKEEPING_DB_PATH;

    // Clear the rules file for this test
    const rulesPath = process.env.BOOKKEEPING_VENDOR_RULES_PATH || join(tmpDir, 'vendor_rules.json');
    writeFileSync(rulesPath, '{}', 'utf-8');

    // Open in-memory ledger
    ledger = openLedger(':memory:');

    // Create necessary accounts
    createAccount(ledger, { name: 'Assets:Checking' });
    createAccount(ledger, { name: 'Equity:Owner' });
    createAccount(ledger, { name: 'Expenses:Office Supplies' });
    createAccount(ledger, { name: 'Expenses:Uncategorized' });
    createAccount(ledger, { name: 'Income:Uncategorized' });
    createAccount(ledger, { name: 'Expenses:Entertainment' });
    createAccount(ledger, { name: 'Expenses:Supplies' });
    createAccount(ledger, { name: 'Income:Freelance' });

    // Post initial transaction
    postTransaction(ledger, {
      date: '2025-01-01',
      description: 'Initial setup',
      splits: [
        { account: 'Assets:Checking', amount: 10000 },
        { account: 'Equity:Owner', amount: -10000 },
      ],
    });
  });

  afterEach(() => {
    if (ledger) {
      closeLedger(ledger);
    }
  });

  describe('Rule normalization and matching', () => {
    it('should normalize payee by lowercasing, trimming, and stripping punctuation', () => {
      assert.strictEqual(normalizePayee('  AMAZON.COM 123456  '), 'amazon com 123456');
      assert.strictEqual(normalizePayee('Trader Joe\'s #42'), 'trader joe s 42');
      assert.strictEqual(normalizePayee('Target (Store #123)'), 'target store 123');
      assert.strictEqual(normalizePayee('CVS/pharmacy'), 'cvs pharmacy');
    });

    it('should collapse multiple spaces to single space', () => {
      assert.strictEqual(normalizePayee('AMAZON   COM    123'), 'amazon com 123');
    });

    it('should match rule on normalized substring', () => {
      const rules: Rules = {
        'amazon': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'low',
          hits: 1,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      const match = matchRule('AMAZON.COM 123456', rules);
      assert.ok(match);
      assert.strictEqual(match.pattern, 'amazon');
      assert.strictEqual(match.rule.accountName, 'Expenses:Office Supplies');
    });

    it('should return null if no rule matches', () => {
      const rules: Rules = {
        'amazon': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'low',
          hits: 1,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      const match = matchRule('Costco #42', rules);
      assert.strictEqual(match, null);
    });

    it('should prefer the longest (most specific) matching rule', () => {
      const rules: Rules = {
        'amazon': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'low',
          hits: 1,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
        'amazon prime': {
          accountName: 'Expenses:Entertainment',
          confidence: 'high',
          hits: 3,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      const match = matchRule('AMAZON PRIME CHARGE', rules);
      assert.ok(match);
      assert.strictEqual(match.pattern, 'amazon prime');
      assert.strictEqual(match.rule.accountName, 'Expenses:Entertainment');
    });

    it('should escalate confidence from low to high after 2+ hits', () => {
      let rules: Rules = {};

      // First upsert: hits=1, confidence=low
      rules = upsertRule(rules, 'amazon', 'Expenses:Office Supplies');
      assert.strictEqual(rules['amazon'].hits, 1);
      assert.strictEqual(rules['amazon'].confidence, 'low');

      // Second upsert (same account): hits=2, confidence=high
      rules = upsertRule(rules, 'amazon', 'Expenses:Office Supplies');
      assert.strictEqual(rules['amazon'].hits, 2);
      assert.strictEqual(rules['amazon'].confidence, 'high');

      // Third upsert (same account): hits=3, confidence stays high
      rules = upsertRule(rules, 'amazon', 'Expenses:Office Supplies');
      assert.strictEqual(rules['amazon'].hits, 3);
      assert.strictEqual(rules['amazon'].confidence, 'high');
    });

    it('extractVendorPattern should strip trailing order numbers/reference codes', () => {
      assert.strictEqual(extractVendorPattern('AMAZON.COM #12345'), 'amazon com');
      assert.strictEqual(extractVendorPattern('AMAZON.COM #98765'), 'amazon com');
      assert.strictEqual(extractVendorPattern("TRADER JOE'S 123 SEATTLE WA"), 'trader joe s');
      assert.strictEqual(extractVendorPattern('Walmart'), 'walmart');
    });

    it('extractVendorPattern should fall back to the full normalized string if the prefix is too short', () => {
      // Starts with a digit -> no non-numeric prefix tokens -> fall back
      assert.strictEqual(extractVendorPattern('123 Main St Purchase'), '123 main st purchase');
    });

    it('should reset hits to 1 when correcting a rule to a different account', () => {
      let rules: Rules = {};

      // Initial: amazon -> Office Supplies with 2 hits
      rules = upsertRule(rules, 'amazon', 'Expenses:Office Supplies');
      rules = upsertRule(rules, 'amazon', 'Expenses:Office Supplies');
      assert.strictEqual(rules['amazon'].hits, 2);
      assert.strictEqual(rules['amazon'].confidence, 'high');

      // Correction: amazon -> Entertainment (different account)
      rules = upsertRule(rules, 'amazon', 'Expenses:Entertainment');
      assert.strictEqual(rules['amazon'].hits, 1);
      assert.strictEqual(rules['amazon'].confidence, 'low');
      assert.strictEqual(rules['amazon'].accountName, 'Expenses:Entertainment');
    });
  });

  describe('listUncategorized', () => {
    it('should return only Uncategorized transactions', () => {
      // Post an uncategorized expense
      postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -2999 },
          { account: 'Assets:Checking', amount: 2999 },
        ],
      });

      // Post a categorized expense
      postTransaction(ledger, {
        date: '2025-07-02',
        description: 'Office Supplies Store',
        splits: [
          { account: 'Expenses:Office Supplies', amount: -1999 },
          { account: 'Assets:Checking', amount: 1999 },
        ],
      });

      const uncategorized = listUncategorized(ledger);
      assert.strictEqual(uncategorized.length, 1);
      assert.strictEqual(uncategorized[0].description, 'AMAZON.COM');
      assert.strictEqual(uncategorized[0].accountName, 'Expenses:Uncategorized');
    });

    it('should filter by kind (expense vs income)', () => {
      // Post an uncategorized expense
      postTransaction(ledger, {
        date: '2025-07-01',
        description: 'Office Supplies',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -2999 },
          { account: 'Assets:Checking', amount: 2999 },
        ],
      });

      // Post an uncategorized income
      postTransaction(ledger, {
        date: '2025-07-02',
        description: 'Freelance gig',
        splits: [
          { account: 'Assets:Checking', amount: 5000 },
          { account: 'Income:Uncategorized', amount: -5000 },
        ],
      });

      const expenses = listUncategorized(ledger, { kind: 'expense' });
      assert.strictEqual(expenses.length, 1);
      assert.strictEqual(expenses[0].accountName, 'Expenses:Uncategorized');

      const income = listUncategorized(ledger, { kind: 'income' });
      assert.strictEqual(income.length, 1);
      assert.strictEqual(income[0].accountName, 'Income:Uncategorized');
    });

    it('should respect the limit parameter', () => {
      // Post 5 uncategorized transactions
      for (let i = 0; i < 5; i++) {
        postTransaction(ledger, {
          date: `2025-07-0${i + 1}`,
          description: `Transaction ${i}`,
          splits: [
            { account: 'Expenses:Uncategorized', amount: -1000 },
            { account: 'Assets:Checking', amount: 1000 },
          ],
        });
      }

      const all = listUncategorized(ledger, { limit: 100 });
      assert.strictEqual(all.length, 5);

      const limited = listUncategorized(ledger, { limit: 2 });
      assert.strictEqual(limited.length, 2);
    });
  });

  describe('suggestCategory', () => {
    it('should suggest a matching rule with confidence', () => {
      const rules: Rules = {
        'amazon': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'high',
          hits: 3,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      const suggestion = suggestCategory('AMAZON.COM 123456', null, rules);
      assert.ok(suggestion.matched);
      assert.strictEqual(suggestion.accountName, 'Expenses:Office Supplies');
      assert.strictEqual(suggestion.confidence, 'high');
      assert.ok(suggestion.explanation.includes('amazon'));
    });

    it('should return matched: false if no rule matches', () => {
      const rules: Rules = {
        'amazon': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'low',
          hits: 1,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      const suggestion = suggestCategory('Unknown Payee Inc', null, rules);
      assert.ok(!suggestion.matched);
    });

    it('should match on payee or memo', () => {
      const rules: Rules = {
        'office depot': {
          accountName: 'Expenses:Office Supplies',
          confidence: 'low',
          hits: 1,
          lastAppliedAt: '2025-07-01T00:00:00.000Z',
        },
      };

      // Match on memo
      const suggestion = suggestCategory('Some Store', 'Office Depot memo', rules);
      assert.ok(suggestion.matched);
      assert.strictEqual(suggestion.accountName, 'Expenses:Office Supplies');
    });
  });

  describe('applyCategory', () => {
    it('should move a split from Uncategorized to a real account', () => {
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -2999 },
          { account: 'Assets:Checking', amount: 2999 },
        ],
      });

      const result = applyCategory(ledger, transactionId, 'Expenses:Office Supplies');

      assert.strictEqual(result.transactionId, transactionId);
      assert.strictEqual(result.newAccountName, 'Expenses:Office Supplies');
      assert.ok(result.ruleRecorded);

      // Verify the split was updated
      const rows = ledger.db.prepare(
        `SELECT s.id, a.name FROM splits s JOIN accounts a ON s.account_id = a.id WHERE s.transaction_id = ?`
      ).all(transactionId) as Array<{ id: number; name: string }>;

      const accountNames = rows.map((r) => r.name).sort();
      assert.deepStrictEqual(accountNames, ['Assets:Checking', 'Expenses:Office Supplies']);
    });

    it('should auto-create the target account if it does not exist', () => {
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'New vendor',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1500 },
          { account: 'Assets:Checking', amount: 1500 },
        ],
      });

      const result = applyCategory(ledger, transactionId, 'Expenses:New:Category:Path');

      assert.strictEqual(result.newAccountName, 'Expenses:New:Category:Path');

      // Verify the account was created
      const rows = ledger.db.prepare(
        `SELECT name FROM accounts WHERE name = ?`
      ).all('Expenses:New:Category:Path') as Array<{ name: string }>;

      assert.strictEqual(rows.length, 1);
    });

    it('should throw if the transaction is not found', () => {
      assert.throws(() => {
        applyCategory(ledger, 9999, 'Expenses:Office Supplies');
      }, /Transaction 9999 not found/);
    });

    it('should throw if the transaction has no expense/income split', () => {
      // Assets:Checking -> Assets:Checking-style transfer, no expense/income leg at all
      createAccount(ledger, { name: 'Assets:Savings' });
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'Transfer to savings',
        splits: [
          { account: 'Assets:Savings', amount: 1000 },
          { account: 'Assets:Checking', amount: -1000 },
        ],
      });

      assert.throws(() => {
        applyCategory(ledger, transactionId, 'Expenses:Other Supplies');
      }, /has no expense\/income split/);
    });

    it('should re-categorize an already-categorized transaction (correction)', () => {
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'Already categorized',
        splits: [
          { account: 'Expenses:Office Supplies', amount: -1000 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      const result = applyCategory(ledger, transactionId, 'Expenses:Supplies');
      assert.strictEqual(result.newAccountName, 'Expenses:Supplies');

      const rows = ledger.db.prepare(
        `SELECT a.name FROM splits s JOIN accounts a ON s.account_id = a.id WHERE s.transaction_id = ?`
      ).all(transactionId) as Array<{ name: string }>;
      const accountNames = rows.map((r) => r.name).sort();
      assert.deepStrictEqual(accountNames, ['Assets:Checking', 'Expenses:Supplies']);
    });

    it('should throw if the transaction has multiple expense/income splits', () => {
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'Multi-way split',
        splits: [
          { account: 'Expenses:Office Supplies', amount: -600 },
          { account: 'Expenses:Entertainment', amount: -400 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      assert.throws(() => {
        applyCategory(ledger, transactionId, 'Expenses:Supplies');
      }, /multiple expense\/income splits/);
    });

    it('should record a rule in vendor_rules.json', () => {
      const { transactionId } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM 123456',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -2999 },
          { account: 'Assets:Checking', amount: 2999 },
        ],
      });

      applyCategory(ledger, transactionId, 'Expenses:Office Supplies');

      const rules = loadRules();
      // The trailing order-number token ("123456") is stripped so the
      // pattern generalizes across repeat AMAZON.COM charges.
      assert.ok('amazon com' in rules);
      const normalizedKey = Object.keys(rules)[0];
      assert.strictEqual(rules[normalizedKey].accountName, 'Expenses:Office Supplies');
      assert.strictEqual(rules[normalizedKey].hits, 1);
    });
  });

  describe('bulkRecategorize', () => {
    beforeEach(() => {
      // Post several uncategorized transactions
      postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON 1000',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1000 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-07-02',
        description: 'AMAZON 5000',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -5000 },
          { account: 'Assets:Checking', amount: 5000 },
        ],
      });

      postTransaction(ledger, {
        date: '2025-07-03',
        description: 'Costco 1500',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1500 },
          { account: 'Assets:Checking', amount: 1500 },
        ],
      });
    });

    it('should bulk-categorize transactions matching payee filter', () => {
      const result = bulkRecategorize(
        ledger,
        { payeeContains: 'AMAZON' },
        'Expenses:Office Supplies'
      );

      assert.strictEqual(result.updated, 2);
      assert.strictEqual(result.transactionIds.length, 2);
    });

    it('should bulk-categorize with payee and amount filters', () => {
      const result = bulkRecategorize(
        ledger,
        { payeeContains: 'AMAZON', maxAmountMinor: 2000 },
        'Expenses:Office Supplies'
      );

      // Only the $10 AMAZON transaction should match (under $20)
      assert.strictEqual(result.updated, 1);
      assert.strictEqual(result.transactionIds.length, 1);
    });

    it('should leave non-matching transactions untouched', () => {
      const beforeUncategorized = listUncategorized(ledger);
      assert.strictEqual(beforeUncategorized.length, 3);

      bulkRecategorize(
        ledger,
        { payeeContains: 'AMAZON' },
        'Expenses:Office Supplies'
      );

      const afterUncategorized = listUncategorized(ledger);
      assert.strictEqual(afterUncategorized.length, 1);
      assert.ok(afterUncategorized[0].description?.includes('Costco'));
    });

    it('should bulk-categorize with kind filter', () => {
      // Post an uncategorized income
      postTransaction(ledger, {
        date: '2025-07-04',
        description: 'AMAZON affiliate income',
        splits: [
          { account: 'Assets:Checking', amount: 500 },
          { account: 'Income:Uncategorized', amount: -500 },
        ],
      });

      // Bulk-categorize only expenses
      const result = bulkRecategorize(
        ledger,
        { payeeContains: 'AMAZON', kind: 'expense' },
        'Expenses:Office Supplies'
      );

      // Only the expense AMAZON transactions should be categorized
      assert.strictEqual(result.updated, 2);
    });
  });

  describe('Rule persistence and retrieval', () => {
    it('should persist a rule after applying a category', () => {
      const { transactionId: tx1 } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1000 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      applyCategory(ledger, tx1, 'Expenses:Office Supplies');

      // Load the rules to verify persistence
      let rules = loadRules();
      const ruleKey = Object.keys(rules)[0];
      assert.ok(ruleKey);
      assert.strictEqual(rules[ruleKey].accountName, 'Expenses:Office Supplies');
      assert.strictEqual(rules[ruleKey].hits, 1);
    });

    it('should increment hits when a learned rule is applied again, even with a different order number', () => {
      // Post and categorize first transaction
      const { transactionId: tx1 } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM #12345',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1000 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      applyCategory(ledger, tx1, 'Expenses:Office Supplies');

      // Verify rule has hits=1, keyed on the vendor prefix (order number stripped)
      let rules = loadRules();
      assert.ok('amazon com' in rules);
      const ruleKey = 'amazon com';
      assert.strictEqual(rules[ruleKey].hits, 1);
      assert.strictEqual(rules[ruleKey].confidence, 'low');

      // Post and categorize a second transaction from the same vendor but with a
      // *different* order number — real-world repeat charges rarely share the
      // exact same description, so the pattern must generalize past it.
      const { transactionId: tx2 } = postTransaction(ledger, {
        date: '2025-07-02',
        description: 'AMAZON.COM #98765',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -2000 },
          { account: 'Assets:Checking', amount: 2000 },
        ],
      });

      applyCategory(ledger, tx2, 'Expenses:Office Supplies');

      // Verify rule has hits=2 and confidence=high
      rules = loadRules();
      assert.strictEqual(rules[ruleKey].hits, 2);
      assert.strictEqual(rules[ruleKey].confidence, 'high');
    });

    it('should update rule on correction (last-write-wins)', () => {
      const { transactionId: tx1 } = postTransaction(ledger, {
        date: '2025-07-01',
        description: 'AMAZON.COM',
        splits: [
          { account: 'Expenses:Uncategorized', amount: -1000 },
          { account: 'Assets:Checking', amount: 1000 },
        ],
      });

      // First categorization
      applyCategory(ledger, tx1, 'Expenses:Office Supplies');

      let rules = loadRules();
      const ruleKey = Object.keys(rules)[0];
      assert.strictEqual(rules[ruleKey].accountName, 'Expenses:Office Supplies');

      // Correction: re-categorize the same (now-categorized) transaction to a
      // different account, through the real apply_category path.
      applyCategory(ledger, tx1, 'Expenses:Supplies');

      rules = loadRules();
      assert.strictEqual(rules[ruleKey].accountName, 'Expenses:Supplies');
      assert.strictEqual(rules[ruleKey].hits, 1);
      assert.strictEqual(rules[ruleKey].confidence, 'low');

      // Verify the split itself actually moved to the corrected account.
      const rows = ledger.db.prepare(
        `SELECT a.name FROM splits s JOIN accounts a ON s.account_id = a.id WHERE s.transaction_id = ?`
      ).all(tx1) as Array<{ name: string }>;
      assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['Assets:Checking', 'Expenses:Supplies']);
    });
  });
});
