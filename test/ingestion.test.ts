/**
 * Unit tests for the bank_sync ingestion extension: dedupe.ts, csv.ts, and
 * ingestion.ts, against an in-memory ledger.
 * Run with: node --test test/ingestion.test.ts
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openLedger,
  closeLedger,
  createAccount,
  resolveAccount,
  listTransactions,
  type Ledger,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import { toMinor } from '../.pi/extensions/bookkeeping/money.ts';
import { findLikelyDuplicates } from '../.pi/extensions/bank_sync/dedupe.ts';
import { ensureUncategorizedAccount, postIngestedEntry, importCsvRows } from '../.pi/extensions/bank_sync/ingestion.ts';
import {
  parseCsvText,
  detectColumns,
  parseDate,
  parseAmountCents,
} from '../.pi/extensions/bank_sync/csv.ts';
import { upsertRule, saveRules, loadRules } from '../.pi/extensions/categorization/rules.ts';

describe('bank_sync ingestion', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bank-sync-test-'));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, 'vendor_rules.json');
  });

  after(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    delete process.env.BOOKKEEPING_VENDOR_RULES_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // High default limit so ingestion tests aren't incidentally blocked by the
    // $500 auto-post threshold; the dedicated threshold test below overrides this.
    process.env.BOOKKEEPING_AUTOPOST_LIMIT = '999999';
    delete process.env.BOOKKEEPING_DB_PATH;

    // Clear the vendor rules file for this test
    const rulesPath = process.env.BOOKKEEPING_VENDOR_RULES_PATH || join(tmpDir, 'vendor_rules.json');
    writeFileSync(rulesPath, '{}', 'utf-8');

    ledger = openLedger(':memory:');
    createAccount(ledger, { name: 'Assets:Checking' });
    // Create root accounts for categorization; use try-catch since they may exist
    try {
      createAccount(ledger, { name: 'Expenses' });
    } catch {
      // Already exists
    }
    try {
      createAccount(ledger, { name: 'Income' });
    } catch {
      // Already exists
    }
  });

  afterEach(() => {
    if (ledger) closeLedger(ledger);
  });

  describe('postIngestedEntry: sign convention and offset account', () => {
    it('negative amount debits Expenses:Uncategorized and credits the source account', () => {
      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in result);

      const uncategorized = resolveAccount(ledger, 'Expenses:Uncategorized');
      const checking = resolveAccount(ledger, 'Assets:Checking');

      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
      const splits = txns[0].splits;
      const checkingSplit = splits.find((s) => s.account_id === checking.id)!;
      const uncatSplit = splits.find((s) => s.account_id === uncategorized.id)!;
      assert.strictEqual(checkingSplit.amount, -5520);
      assert.strictEqual(uncatSplit.amount, 5520);
    });

    it('positive amount credits Income:Uncategorized and debits the source account', () => {
      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: 150000,
        account: 'Assets:Checking',
        description: 'Paycheck',
      });
      assert.ok('transactionId' in result);

      const uncategorized = resolveAccount(ledger, 'Income:Uncategorized');
      const checking = resolveAccount(ledger, 'Assets:Checking');

      const txns = listTransactions(ledger, { limit: 10 });
      const splits = txns[0].splits;
      const checkingSplit = splits.find((s) => s.account_id === checking.id)!;
      const uncatSplit = splits.find((s) => s.account_id === uncategorized.id)!;
      assert.strictEqual(checkingSplit.amount, 150000);
      assert.strictEqual(uncatSplit.amount, -150000);
    });
  });

  describe('ensureUncategorizedAccount', () => {
    it('auto-creates Expenses:Uncategorized and Income:Uncategorized on first use', () => {
      const expenseAcc = ensureUncategorizedAccount(ledger, 'expense');
      assert.strictEqual(expenseAcc.name, 'Expenses:Uncategorized');
      assert.strictEqual(expenseAcc.type, 'expense');

      const incomeAcc = ensureUncategorizedAccount(ledger, 'income');
      assert.strictEqual(incomeAcc.name, 'Income:Uncategorized');
      assert.strictEqual(incomeAcc.type, 'income');
    });

    it('reuses the existing account on subsequent calls (not duplicated)', () => {
      const first = ensureUncategorizedAccount(ledger, 'expense');
      const second = ensureUncategorizedAccount(ledger, 'expense');
      assert.strictEqual(first.id, second.id);
    });
  });

  describe('duplicate blocking on log path', () => {
    it('blocks a second identical call (same date/amount/payee)', () => {
      const first = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in first);

      const second = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('duplicate' in second);
      if ('duplicate' in second) {
        assert.strictEqual(second.duplicate.transactionId, (first as any).transactionId);
      }

      // Nothing new was written.
      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
    });

    it('posts when force: true is passed, even if a duplicate is found', () => {
      postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });

      const forced = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
        force: true,
      });
      assert.ok('transactionId' in forced);

      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 2);
    });

    it('does not flag as duplicate when outside the date window', () => {
      postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });

      // 4 days apart, windowDays default 3 -> not flagged
      const result = postIngestedEntry(ledger, {
        date: '2024-06-05',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in result);

      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 2);
    });
  });

  describe('findLikelyDuplicates: fuzzy description matching', () => {
    beforeEach(() => {
      postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's #123",
      });
    });

    it('flags a fuzzy-matching description as a likely duplicate', () => {
      const matches = findLikelyDuplicates(ledger, {
        account: 'Assets:Checking',
        amountMinor: -5520,
        date: '2024-06-01',
        description: 'TRADER JOES 123 SEATTLE',
      });
      assert.strictEqual(matches.length, 1);
    });

    it('does not flag an unrelated payee at the same date/amount', () => {
      const matches = findLikelyDuplicates(ledger, {
        account: 'Assets:Checking',
        amountMinor: -5520,
        date: '2024-06-01',
        description: 'Shell Gas Station',
      });
      assert.strictEqual(matches.length, 0);
    });
  });

  describe('csv.ts: parsing and column detection', () => {
    it('parses a well-formed CSV with a single signed amount column', () => {
      const text = 'Date,Description,Amount\n2024-06-01,Trader Joes,-55.20\n2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      assert.deepStrictEqual(header, ['Date', 'Description', 'Amount']);
      assert.strictEqual(rows.length, 2);

      const cols = detectColumns(header);
      assert.strictEqual(parseDate(rows[0][cols.dateCol]), '2024-06-01');
      assert.strictEqual(parseAmountCents(rows[0], cols), -5520);
      assert.strictEqual(parseAmountCents(rows[1], cols), 150000);
    });

    it('parses a CSV with separate debit/credit columns producing signed amounts', () => {
      const text = 'Date,Description,Debit,Credit\n2024-06-01,Trader Joes,55.20,\n2024-06-03,Paycheck,,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(parseAmountCents(rows[0], cols), -5520);
      assert.strictEqual(parseAmountCents(rows[1], cols), 150000);
    });

    it('auto-detects common header variants without overrides', () => {
      const text = 'Posted Date,Payee,Amount\n06/01/2024,Trader Joes,-55.20\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(parseDate(rows[0][cols.dateCol]), '2024-06-01');
      assert.strictEqual(rows[0][cols.descriptionCol], 'Trader Joes');
    });

    it('throws a clear error when no recognizable columns and no overrides are given', () => {
      const text = 'Foo,Bar,Baz\n1,2,3\n';
      const { header } = parseCsvText(text);
      assert.throws(() => detectColumns(header), /no recognizable columns/i);
    });

    it('resolves columns via overrides when headers do not match aliases', () => {
      const text = 'TxnDate,Merchant,Total\n2024-06-01,Trader Joes,-55.20\n';
      const { header } = parseCsvText(text);
      const cols = detectColumns(header, {
        date_column: 'TxnDate',
        amount_column: 'Total',
        description_column: 'Merchant',
      });
      assert.strictEqual(cols.dateCol, 0);
      assert.strictEqual(cols.amountCol, 2);
      assert.strictEqual(cols.descriptionCol, 1);
    });

    it('normalizes MM/DD/YYYY and YYYY-MM-DD dates', () => {
      assert.strictEqual(parseDate('06/01/2024'), '2024-06-01');
      assert.strictEqual(parseDate('2024-06-01'), '2024-06-01');
    });

    it('throws on an unparseable date', () => {
      assert.throws(() => parseDate('June 1st, 2024'), /unparseable date/i);
    });

    it('handles quoted fields with embedded commas', () => {
      const text = 'Date,Description,Amount\n2024-06-01,"Trader Joe\'s, Seattle #123",-55.20\n';
      const { rows } = parseCsvText(text);
      assert.strictEqual(rows[0][1], "Trader Joe's, Seattle #123");
    });

    it('parseAmountCents parses single-amount column with parenthesized negatives (45.00)', () => {
      const text = 'Date,Description,Amount\n2024-06-01,Test,(45.00)\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(parseAmountCents(rows[0], cols), -4500);
    });

    it('parseAmountCents parses single-amount column with parenthesized negatives ($1,234.56)', () => {
      const text = 'Date,Description,Amount\n2024-06-01,Test,"($1,234.56)"\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(parseAmountCents(rows[0], cols), -123456);
    });

    it('parseAmountCents on debit/credit columns with parenthesized debit (55.20)', () => {
      const text = 'Date,Description,Debit,Credit\n2024-06-01,Test,(55.20),\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      // Parenthesized debit negates to -55.20; formula credit - debit = 0 - (-55.20) = 55.20 → 5520 cents
      assert.strictEqual(parseAmountCents(rows[0], cols), 5520);
    });

    it('parseAmountCents on debit/credit columns with parenthesized credit (20.00)', () => {
      const text = 'Date,Description,Debit,Credit\n2024-06-01,Test,,(20.00)\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      // Parenthesized credit negates to -20.00; formula credit - debit = -20.00 - 0 = -20.00 → -2000 cents
      assert.strictEqual(parseAmountCents(rows[0], cols), -2000);
    });

    it('throws "Non-numeric amount" for non-numeric, non-parenthesized values (regression check)', () => {
      const text = 'Date,Description,Amount\n2024-06-01,Test,abc\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.throws(() => parseAmountCents(rows[0], cols), /Non-numeric amount/);
    });

    it('detectColumns resolves separate Description and Memo columns correctly', () => {
      const text = 'Date,Description,Memo,Amount\n2024-06-01,Payee text,Memo text,100\n';
      const { header } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(cols.descriptionCol, 1); // Description column
      assert.strictEqual(cols.memoCol, 2); // Memo column (separate)
      assert.notStrictEqual(cols.memoCol, cols.descriptionCol);
    });

    it('detectColumns with only Memo column (no Description) uses Memo as description, memoCol is null', () => {
      const text = 'Date,Memo,Amount\n2024-06-01,Memo text,100\n';
      const { header } = parseCsvText(text);
      const cols = detectColumns(header);
      assert.strictEqual(cols.descriptionCol, 1); // Memo is used as description
      assert.strictEqual(cols.memoCol, null); // No separate memo column (no double-count)
    });

    it('detectColumns respects memo_column override', () => {
      const text = 'Date,Description,CustomMemo,Amount\n2024-06-01,Payee,Memo text,100\n';
      const { header } = parseCsvText(text);
      const cols = detectColumns(header, { memo_column: 'CustomMemo' });
      assert.strictEqual(cols.descriptionCol, 1);
      assert.strictEqual(cols.memoCol, 2); // Resolved via override
    });
  });

  // These exercise importCsvRows directly — the same helper index.ts's
  // import_csv tool calls — so row-number math, override plumbing, and
  // imported/skippedDuplicates/errors shaping are covered by the real
  // adapter logic, not a hand-rolled re-implementation of it.
  describe('importCsvRows (the row-loop behind import_csv)', () => {
    it('posts every row of a well-formed CSV as an uncategorized entry', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      assert.strictEqual(result.imported.length, 2);
      assert.strictEqual(result.skippedDuplicates.length, 0);
      assert.strictEqual(result.errors.length, 0);
      assert.deepStrictEqual(result.imported.map((r) => r.row), [2, 3]);
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 2);
    });

    it('reports a malformed row (correct 1-indexed row number) and continues processing remaining valid rows', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        'not-a-date,Bad Row,abc\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      assert.strictEqual(result.imported.length, 2);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.errors[0].row, 3);
    });

    it('skips-and-reports duplicates on re-import; force_duplicates re-posts them', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const firstRun = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });
      assert.strictEqual(firstRun.imported.length, 2);

      // Re-run without force: every row should be a skipped duplicate,
      // reported with the matched transaction id.
      const secondRun = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });
      assert.strictEqual(secondRun.imported.length, 0);
      assert.strictEqual(secondRun.skippedDuplicates.length, 2);
      assert.deepStrictEqual(
        secondRun.skippedDuplicates.map((d) => d.transactionId).sort(),
        firstRun.imported.map((r) => r.transactionId).sort()
      );
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 2);

      // Re-run with force_duplicates: rows post again.
      const thirdRun = importCsvRows(ledger, rows, cols, {
        account: 'Assets:Checking',
        forceDuplicates: true,
      });
      assert.strictEqual(thirdRun.imported.length, 2);
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 4);
    });

    it('reports a threshold-blocked row in errors and still imports the rest of the file', () => {
      process.env.BOOKKEEPING_AUTOPOST_LIMIT = '100'; // $100 limit
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Big Purchase,-50000\n' + // way above $100 limit
        '2024-06-03,Small Purchase,-20.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, {
        account: 'Assets:Checking',
        approved: false,
      });

      assert.strictEqual(result.imported.length, 1);
      assert.strictEqual(result.errors.length, 1);
      assert.match(result.errors[0].reason, /exceeds auto-post limit/);
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 1);
    });

    it('passes date_window_days through to duplicate detection', () => {
      const text = 'Date,Description,Amount\n2024-06-01,Trader Joes,-55.20\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      // Same amount/description 10 days later: outside a windowDays: 1 window,
      // so it should NOT be treated as a duplicate.
      const laterText = 'Date,Description,Amount\n2024-06-11,Trader Joes,-55.20\n';
      const laterParsed = parseCsvText(laterText);
      const laterCols = detectColumns(laterParsed.header);

      const result = importCsvRows(ledger, laterParsed.rows, laterCols, {
        account: 'Assets:Checking',
        windowDays: 1,
      });
      assert.strictEqual(result.imported.length, 1);
      assert.strictEqual(result.skippedDuplicates.length, 0);
    });

    it('CSV with Description and Memo columns posts transaction with split memo matching Memo column', () => {
      const text =
        'Date,Description,Memo,Amount\n' +
        '2024-06-01,Trader Joes,Store #456,-55.20\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      assert.strictEqual(result.imported.length, 1);
      assert.strictEqual(result.errors.length, 0);

      // Verify the transaction's splits include the memo
      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
      const splits = txns[0].splits;
      const checkingSplit = splits.find((s) => s.account_id === resolveAccount(ledger, 'Assets:Checking').id)!;
      assert.strictEqual(checkingSplit.memo, 'Store #456');
    });

    it('memo participates in vendor-rule matching via payee+memo join', () => {
      // Set up a high-confidence rule keyed on payee+memo text
      // "Trader Joes" + "Store" combined normalizes to "trader joes store"
      let rules = loadRules();
      // Insert a rule that matches the combined payee+memo
      rules = upsertRule(rules, 'trader joes store', 'Expenses:Groceries');
      rules = upsertRule(rules, 'trader joes store', 'Expenses:Groceries'); // high confidence
      saveRules(rules);

      const text =
        'Date,Description,Memo,Amount\n' +
        '2024-06-01,Trader Joes,Store #456,-55.20\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      assert.strictEqual(result.imported.length, 1);
      assert.strictEqual(result.errors.length, 0);

      // Verify the transaction posted to Expenses:Groceries (matched rule), not Uncategorized
      const groceriesAccount = resolveAccount(ledger, 'Expenses:Groceries');
      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
      const splits = txns[0].splits;
      const groceriesSplit = splits.find((s) => s.account_id === groceriesAccount.id)!;
      assert.ok(groceriesSplit, 'Should have posted to Expenses:Groceries via payee+memo rule match');

      // Uncategorized account should NOT have been created
      try {
        resolveAccount(ledger, 'Expenses:Uncategorized');
        assert.fail('Expenses:Uncategorized should not have been created');
      } catch {
        // Expected: account doesn't exist
      }
    });
  });

  describe('money helper reuse', () => {
    it('toMinor converts log_transaction-style major amounts to minor units', () => {
      assert.strictEqual(toMinor(-55.2), -5520);
      assert.strictEqual(toMinor(1500), 150000);
    });
  });

  describe('auto-categorization via vendor rules', () => {
    it('high-confidence rule match posts directly against the matched category account, not Uncategorized', () => {
      // Set up a high-confidence vendor rule for Trader Joe's → Expenses:Food
      // Use pattern 'trader joe' which will match the normalized payee 'trader joe s'
      let rules = loadRules();
      rules = upsertRule(rules, 'trader joe', 'Expenses:Food');
      rules = upsertRule(rules, 'trader joe', 'Expenses:Food'); // 2nd call makes confidence 'high'
      saveRules(rules);

      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in result);

      // Verify the transaction posted against Expenses:Food, not Expenses:Uncategorized
      const foodAccount = resolveAccount(ledger, 'Expenses:Food');
      const checking = resolveAccount(ledger, 'Assets:Checking');

      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
      const splits = txns[0].splits;
      const checkingSplit = splits.find((s) => s.account_id === checking.id)!;
      const categorySplit = splits.find((s) => s.account_id === foodAccount.id)!;
      assert.strictEqual(checkingSplit.amount, -5520);
      assert.strictEqual(categorySplit.amount, 5520);

      // Uncategorized account should NOT have been created
      try {
        resolveAccount(ledger, 'Expenses:Uncategorized');
        assert.fail('Expenses:Uncategorized should not have been created');
      } catch {
        // Expected: account doesn't exist
      }
    });

    it('low-confidence rule match (hits: 1) falls back to Uncategorized', () => {
      // Set up a low-confidence vendor rule (only 1 hit)
      let rules = loadRules();
      rules = upsertRule(rules, 'trader joe', 'Expenses:Food'); // 1st call makes confidence 'low'
      saveRules(rules);

      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in result);

      // Verify the transaction posted against Expenses:Uncategorized, not Expenses:Food
      const uncategorized = resolveAccount(ledger, 'Expenses:Uncategorized');
      const checking = resolveAccount(ledger, 'Assets:Checking');

      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 1);
      const splits = txns[0].splits;
      const checkingSplit = splits.find((s) => s.account_id === checking.id)!;
      const uncatSplit = splits.find((s) => s.account_id === uncategorized.id)!;
      assert.strictEqual(checkingSplit.amount, -5520);
      assert.strictEqual(uncatSplit.amount, 5520);
    });

    it('no matching rule falls back to Uncategorized (regression check)', () => {
      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -5520,
        account: 'Assets:Checking',
        description: "Trader Joe's",
      });
      assert.ok('transactionId' in result);

      // Verify posted to Expenses:Uncategorized
      const uncategorized = resolveAccount(ledger, 'Expenses:Uncategorized');
      const txns = listTransactions(ledger, { limit: 10 });
      const splits = txns[0].splits;
      const uncatSplit = splits.find((s) => s.account_id === uncategorized.id)!;
      assert.ok(uncatSplit);
    });

    it('type mismatch (income amount but expense rule) falls back to Uncategorized', () => {
      // Set up a high-confidence rule pointing to an EXPENSE account
      let rules = loadRules();
      rules = upsertRule(rules, 'freelance', 'Expenses:Consulting');
      rules = upsertRule(rules, 'freelance', 'Expenses:Consulting'); // high confidence
      saveRules(rules);

      // Try to post an INCOME entry (positive amount) matching the rule
      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: 50000,
        account: 'Assets:Checking',
        description: 'Freelance work',
      });
      assert.ok('transactionId' in result);

      // Should have posted to Income:Uncategorized, not Expenses:Consulting
      const incomeUncat = resolveAccount(ledger, 'Income:Uncategorized');
      const txns = listTransactions(ledger, { limit: 10 });
      const splits = txns[0].splits;
      const incomeUncatSplit = splits.find((s) => s.account_id === incomeUncat.id)!;
      assert.ok(incomeUncatSplit);

      // Expenses:Consulting should exist (from the rule definition) but should NOT have been used
      const consultingAccount = resolveAccount(ledger, 'Expenses:Consulting');
      const consultingSplit = splits.find((s) => s.account_id === consultingAccount.id);
      assert.ok(!consultingSplit, 'Expenses:Consulting split should not exist');
    });

    it('matched category account auto-created if it does not exist yet', () => {
      // Set up a high-confidence rule for a non-existent account
      let rules = loadRules();
      rules = upsertRule(rules, 'fancy', 'Expenses:Dining');
      rules = upsertRule(rules, 'fancy', 'Expenses:Dining'); // high confidence
      saveRules(rules);

      // Expenses:Dining should not exist yet
      try {
        resolveAccount(ledger, 'Expenses:Dining');
        assert.fail('Expenses:Dining should not exist yet');
      } catch {
        // Expected
      }

      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -12500,
        account: 'Assets:Checking',
        description: 'Fancy restaurant',
      });
      assert.ok('transactionId' in result);

      // Now Expenses:Dining should exist and the transaction should have posted against it
      const diningAccount = resolveAccount(ledger, 'Expenses:Dining');
      assert.strictEqual(diningAccount.name, 'Expenses:Dining');
      assert.strictEqual(diningAccount.type, 'expense');

      const txns = listTransactions(ledger, { limit: 10 });
      const splits = txns[0].splits;
      const diningSplit = splits.find((s) => s.account_id === diningAccount.id)!;
      assert.strictEqual(diningSplit.amount, 12500);
    });

    it('falls back to Uncategorized when the matched account cannot be created (unknown root)', () => {
      // Rule points at an account whose root doesn't exist, so createAccount
      // can't infer a type and throws — resolveCategoryForEntry must swallow
      // that and fall back to Uncategorized rather than crashing ingestion.
      let rules = loadRules();
      rules = upsertRule(rules, 'bogus vendor', 'BogusRoot:Something');
      rules = upsertRule(rules, 'bogus vendor', 'BogusRoot:Something'); // high confidence
      saveRules(rules);

      const result = postIngestedEntry(ledger, {
        date: '2024-06-01',
        amountMinor: -1000,
        account: 'Assets:Checking',
        description: 'Bogus Vendor',
      });
      assert.ok('transactionId' in result);

      const uncategorized = resolveAccount(ledger, 'Expenses:Uncategorized');
      const txns = listTransactions(ledger, { limit: 10 });
      const splits = txns[0].splits;
      const uncategorizedSplit = splits.find((s) => s.account_id === uncategorized.id);
      assert.ok(uncategorizedSplit, 'should have fallen back to Expenses:Uncategorized');
    });

    it('importCsvRows applies high-confidence rules per row and loads rules once', () => {
      // Set up high-confidence rules
      let rules = loadRules();
      rules = upsertRule(rules, 'trader joe', 'Expenses:Food');
      rules = upsertRule(rules, 'trader joe', 'Expenses:Food');
      rules = upsertRule(rules, 'amazon', 'Expenses:Shopping');
      rules = upsertRule(rules, 'amazon', 'Expenses:Shopping');
      saveRules(rules);

      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        '2024-06-02,Amazon Purchase,-29.99\n' +
        '2024-06-03,Trader Joes,-32.15\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const result = importCsvRows(ledger, rows, cols, { account: 'Assets:Checking' });

      assert.strictEqual(result.imported.length, 3);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.skippedDuplicates.length, 0);

      // Verify all three transactions posted to their matched categories, not Uncategorized
      const txns = listTransactions(ledger, { limit: 10 });
      assert.strictEqual(txns.length, 3);

      const foodAccount = resolveAccount(ledger, 'Expenses:Food');
      const shoppingAccount = resolveAccount(ledger, 'Expenses:Shopping');

      // Verify first row (Trader Joes) posted to Food
      const firstSplits = txns[2].splits; // reverse order due to desc by date
      const foodSplit1 = firstSplits.find((s) => s.account_id === foodAccount.id);
      assert.ok(foodSplit1, 'First Trader Joes should post to Expenses:Food');

      // Verify second row (Amazon) posted to Shopping
      const secondSplits = txns[1].splits;
      const shoppingSplit = secondSplits.find((s) => s.account_id === shoppingAccount.id);
      assert.ok(shoppingSplit, 'Amazon should post to Expenses:Shopping');

      // Verify third row (Trader Joes) posted to Food
      const thirdSplits = txns[0].splits;
      const foodSplit2 = thirdSplits.find((s) => s.account_id === foodAccount.id);
      assert.ok(foodSplit2, 'Second Trader Joes should post to Expenses:Food');

      // Uncategorized account should NOT have been created
      try {
        resolveAccount(ledger, 'Expenses:Uncategorized');
        assert.fail('Expenses:Uncategorized should not have been created');
      } catch {
        // Expected: account doesn't exist
      }
    });
  });
});
