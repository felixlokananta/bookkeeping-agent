/**
 * Unit tests for the bank_sync ingestion extension: dedupe.ts, csv.ts, and
 * ingestion.ts, against an in-memory ledger.
 * Run with: node --test test/ingestion.test.ts
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync } from 'fs';
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
import { ensureUncategorizedAccount, postIngestedEntry } from '../.pi/extensions/bank_sync/ingestion.ts';
import {
  parseCsvText,
  detectColumns,
  parseDate,
  parseAmountCents,
} from '../.pi/extensions/bank_sync/csv.ts';

describe('bank_sync ingestion', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bank-sync-test-'));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
  });

  after(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // High default limit so ingestion tests aren't incidentally blocked by the
    // $500 auto-post threshold; the dedicated threshold test below overrides this.
    process.env.BOOKKEEPING_AUTOPOST_LIMIT = '999999';
    delete process.env.BOOKKEEPING_DB_PATH;
    ledger = openLedger(':memory:');
    createAccount(ledger, { name: 'Assets:Checking' });
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
  });

  describe('import_csv-style bulk processing (row-level errors, dedup, threshold)', () => {
    it('posts every row of a well-formed CSV as an uncategorized entry', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const results = rows.map((row) =>
        postIngestedEntry(ledger, {
          date: parseDate(row[cols.dateCol]),
          amountMinor: parseAmountCents(row, cols),
          account: 'Assets:Checking',
          description: row[cols.descriptionCol],
        })
      );
      assert.ok(results.every((r) => 'transactionId' in r));
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 2);
    });

    it('reports a malformed row and continues processing remaining valid rows', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        'not-a-date,Bad Row,abc\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const errors: Array<{ row: number; reason: string }> = [];
      let posted = 0;
      rows.forEach((row, idx) => {
        try {
          const date = parseDate(row[cols.dateCol]);
          const amountMinor = parseAmountCents(row, cols);
          postIngestedEntry(ledger, {
            date,
            amountMinor,
            account: 'Assets:Checking',
            description: row[cols.descriptionCol],
          });
          posted++;
        } catch (err: any) {
          errors.push({ row: idx + 2, reason: err.message });
        }
      });

      assert.strictEqual(posted, 2);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].row, 3);
    });

    it('skips-and-reports duplicates on re-import; force_duplicates re-posts them', () => {
      const text =
        'Date,Description,Amount\n' +
        '2024-06-01,Trader Joes,-55.20\n' +
        '2024-06-03,Paycheck,1500.00\n';
      const { header, rows } = parseCsvText(text);
      const cols = detectColumns(header);

      const firstRun = rows.map((row) =>
        postIngestedEntry(ledger, {
          date: parseDate(row[cols.dateCol]),
          amountMinor: parseAmountCents(row, cols),
          account: 'Assets:Checking',
          description: row[cols.descriptionCol],
        })
      );
      assert.ok(firstRun.every((r) => 'transactionId' in r));

      // Re-run without force: every row should be a skipped duplicate.
      const secondRun = rows.map((row) =>
        postIngestedEntry(ledger, {
          date: parseDate(row[cols.dateCol]),
          amountMinor: parseAmountCents(row, cols),
          account: 'Assets:Checking',
          description: row[cols.descriptionCol],
        })
      );
      assert.ok(secondRun.every((r) => 'duplicate' in r));
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 2);

      // Re-run with force: rows post again.
      const thirdRun = rows.map((row) =>
        postIngestedEntry(ledger, {
          date: parseDate(row[cols.dateCol]),
          amountMinor: parseAmountCents(row, cols),
          account: 'Assets:Checking',
          description: row[cols.descriptionCol],
          force: true,
        })
      );
      assert.ok(thirdRun.every((r) => 'transactionId' in r));
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

      const errors: Array<{ row: number; reason: string }> = [];
      let posted = 0;
      rows.forEach((row, idx) => {
        try {
          postIngestedEntry(ledger, {
            date: parseDate(row[cols.dateCol]),
            amountMinor: parseAmountCents(row, cols),
            account: 'Assets:Checking',
            description: row[cols.descriptionCol],
          });
          posted++;
        } catch (err: any) {
          errors.push({ row: idx + 2, reason: err.message });
        }
      });

      assert.strictEqual(posted, 1);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].reason, /exceeds auto-post limit/);
      assert.strictEqual(listTransactions(ledger, { limit: 10 }).length, 1);
    });
  });

  describe('money helper reuse', () => {
    it('toMinor converts log_transaction-style major amounts to minor units', () => {
      assert.strictEqual(toMinor(-55.2), -5520);
      assert.strictEqual(toMinor(1500), 150000);
    });
  });
});
