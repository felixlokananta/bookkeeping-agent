/**
 * Receipt OCR extension unit tests.
 * Tests capture.ts functions (loadReceiptImage, postReceiptEntry) against an in-memory ledger.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  openLedger,
  closeLedger,
  listTransactions,
  createAccount,
  postTransaction,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import { loadReceiptImage, postReceiptEntry } from '../.pi/extensions/receipt_ocr/capture.ts';
import type { Ledger } from '../.pi/extensions/bookkeeping/ledger.ts';

describe('Receipt OCR: image loading and posting', () => {
  let ledger: Ledger;

  // Setup: open in-memory ledger before each test
  it('should set up in-memory ledger', () => {
    ledger = openLedger(':memory:');
    assert.ok(ledger);
    assert.ok(ledger.db);
  });

  describe('loadReceiptImage', () => {
    it('should load a valid PNG file and return base64 data + correct mimeType', () => {
      const fixturePath = join(process.cwd(), 'test/fixtures/receipt.png');
      const result = loadReceiptImage(fixturePath);

      assert.ok(result.data);
      assert.strictEqual(result.mimeType, 'image/png');
      assert.ok(result.data.length > 0);
      // Verify it's valid base64 by decoding
      assert.doesNotThrow(() => Buffer.from(result.data, 'base64'));
    });

    it('should reject .pdf files with a clear unsupported-format error', () => {
      const testPdfPath = join(process.cwd(), 'test/fixtures/test.pdf');
      writeFileSync(testPdfPath, 'fake pdf content');

      assert.throws(
        () => loadReceiptImage(testPdfPath),
        (err: any) => {
          assert.match(err.message, /PDF.*not yet supported|convert.*image/i);
          return true;
        }
      );

      unlinkSync(testPdfPath);
    });

    it('should reject unsupported extensions (e.g. .txt)', () => {
      const testTxtPath = join(process.cwd(), 'test/fixtures/test.txt');
      writeFileSync(testTxtPath, 'some text');

      assert.throws(
        () => loadReceiptImage(testTxtPath),
        (err: any) => {
          assert.match(err.message, /Unsupported file format/i);
          return true;
        }
      );

      unlinkSync(testTxtPath);
    });

    it('should throw a clear file-not-found error for missing files', () => {
      assert.throws(
        () => loadReceiptImage('test/fixtures/nonexistent.png'),
        (err: any) => {
          assert.match(err.message, /not found/i);
          return true;
        }
      );
    });
  });

  describe('postReceiptEntry', () => {
    // Create a test account before these tests
    it('should create test accounts', () => {
      createAccount(ledger, { name: 'Assets:TestBank', type: 'asset' });
      assert.ok(ledger);
    });

    it('should post a high-confidence negative amount (expense) as balanced entry', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-01',
        amountMinor: -5000, // $50.00 expense
        account: 'Assets:TestBank',
        payee: 'Coffee Shop',
        memo: 'Morning coffee',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      assert.ok('transactionId' in result);
      assert.ok('splitIds' in result);
      assert.strictEqual(result.splitIds.length, 2);
    });

    it('should post a high-confidence positive amount (income) as balanced entry', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-02',
        amountMinor: 10000, // $100.00 income
        account: 'Assets:TestBank',
        payee: 'Freelance Work',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      assert.ok('transactionId' in result);
      assert.ok('splitIds' in result);
      assert.strictEqual(result.splitIds.length, 2);
    });

    it('should persist source_path on created transactions', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-03',
        amountMinor: -2500, // $25.00
        account: 'Assets:TestBank',
        payee: 'Gas',
        sourcePath: 'data/inbox/receipt_001.jpg',
        confidence: 'high',
      });

      const transactions = listTransactions(ledger, { limit: 100 });
      const posted = transactions.find((tx) => tx.id === result.transactionId);
      assert.ok(posted);
      assert.strictEqual(posted.source_path, 'data/inbox/receipt_001.jpg');
    });

    it('should block low-confidence posts without force', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-04',
        amountMinor: -3500,
        account: 'Assets:TestBank',
        payee: 'Blurry Receipt',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'low',
        uncertainFields: ['date', 'amount'],
      });

      assert.ok('lowConfidence' in result);
      assert.deepStrictEqual(result.lowConfidence, ['date', 'amount']);
    });

    it('should use default uncertain fields ["unspecified"] when none provided with low-confidence', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-05',
        amountMinor: -1000,
        account: 'Assets:TestBank',
        payee: 'Unclear',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'low',
      });

      assert.ok('lowConfidence' in result);
      assert.deepStrictEqual(result.lowConfidence, ['unspecified']);
    });

    it('should allow low-confidence posts when force: true', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-06',
        amountMinor: -4500,
        account: 'Assets:TestBank',
        payee: 'Forced Low-Confidence',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'low',
        uncertainFields: ['payee'],
        force: true,
      });

      assert.ok('transactionId' in result);
      assert.ok('splitIds' in result);
    });

    it('should reuse Expenses:Uncategorized account across calls (not duplicate)', () => {
      // Post first expense
      const result1 = postReceiptEntry(ledger, {
        date: '2026-07-07',
        amountMinor: -1000,
        account: 'Assets:TestBank',
        payee: 'First Expense',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      // Post second expense
      const result2 = postReceiptEntry(ledger, {
        date: '2026-07-08',
        amountMinor: -2000,
        account: 'Assets:TestBank',
        payee: 'Second Expense',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      // Both should succeed, and both should reference the same Expenses:Uncategorized
      assert.ok('transactionId' in result1);
      assert.ok('transactionId' in result2);

      const txns = listTransactions(ledger, { limit: 100 });
      const splits1 = txns.find((tx) => tx.id === result1.transactionId)?.splits || [];
      const splits2 = txns.find((tx) => tx.id === result2.transactionId)?.splits || [];

      // Find the Uncategorized split in each (should have the same account_id)
      const uncatSplit1 = splits1.find((s) => s.amount > 0); // Expenses:Uncategorized offsets with positive
      const uncatSplit2 = splits2.find((s) => s.amount > 0);

      assert.ok(uncatSplit1);
      assert.ok(uncatSplit2);
      assert.strictEqual(uncatSplit1.account_id, uncatSplit2.account_id);
    });

    it('should create and reuse Income:Uncategorized for positive amounts', () => {
      const result1 = postReceiptEntry(ledger, {
        date: '2026-07-09',
        amountMinor: 5000,
        account: 'Assets:TestBank',
        payee: 'First Income',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      const result2 = postReceiptEntry(ledger, {
        date: '2026-07-10',
        amountMinor: 7500,
        account: 'Assets:TestBank',
        payee: 'Second Income',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
      });

      const txns = listTransactions(ledger, { limit: 100 });
      const splits1 = txns.find((tx) => tx.id === result1.transactionId)?.splits || [];
      const splits2 = txns.find((tx) => tx.id === result2.transactionId)?.splits || [];

      // Find the Uncategorized split (negative for income offsets)
      const uncatSplit1 = splits1.find((s) => s.amount < 0);
      const uncatSplit2 = splits2.find((s) => s.amount < 0);

      assert.ok(uncatSplit1);
      assert.ok(uncatSplit2);
      assert.strictEqual(uncatSplit1.account_id, uncatSplit2.account_id);
    });

    it('should block posts exceeding the auto-post threshold (inherited from postTransaction)', () => {
      // The default threshold is $500 = 50000 cents
      assert.throws(
        () =>
          postReceiptEntry(ledger, {
            date: '2026-07-11',
            amountMinor: -60000, // $600, above $500 limit
            account: 'Assets:TestBank',
            payee: 'Large Purchase',
            sourcePath: 'test/fixtures/receipt.png',
            confidence: 'high',
          }),
        (err: any) => {
          assert.match(err.message, /exceed.*limit|above.*threshold/i);
          return true;
        }
      );
    });

    it('should allow above-threshold posts with approved: true', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-12',
        amountMinor: -60000, // $600, above $500 limit
        account: 'Assets:TestBank',
        payee: 'Large Approved Purchase',
        sourcePath: 'test/fixtures/receipt.png',
        confidence: 'high',
        approved: true,
      });

      assert.ok('transactionId' in result);
      assert.ok('splitIds' in result);
    });

    it('should post without source_path if not provided (source_path null)', () => {
      const result = postReceiptEntry(ledger, {
        date: '2026-07-13',
        amountMinor: -1500,
        account: 'Assets:TestBank',
        payee: 'No Source Path',
        sourcePath: '',
        confidence: 'high',
      });

      assert.ok('transactionId' in result);

      const txn = listTransactions(ledger, { limit: 100 }).find((tx) => tx.id === result.transactionId);
      assert.ok(txn);
      // source_path is stored as empty string (not null, since we passed '')
      assert.strictEqual(txn.source_path, '' || null);
    });
  });

  // Teardown: close ledger after all tests
  it('should close ledger', () => {
    closeLedger(ledger);
  });
});

describe('Legacy ledger behavior (Issue #1 compatibility)', () => {
  let ledger: Ledger;

  it('should initialize ledger', () => {
    ledger = openLedger(':memory:');
    assert.ok(ledger);
  });

  it('should still have source_path = null on transactions posted via postTransaction (without sourcePath param)', () => {
    createAccount(ledger, { name: 'Assets:Check2', type: 'asset' });
    createAccount(ledger, { name: 'Equity:Owner2', type: 'equity' });

    postTransaction(ledger, {
      date: '2026-07-01',
      description: 'Test post without sourcePath',
      splits: [
        { account: 'Assets:Check2', amount: 5000 },
        { account: 'Equity:Owner2', amount: -5000 },
      ],
    });

    const txns = listTransactions(ledger, { limit: 100 });
    const posted = txns.find((tx) => tx.description === 'Test post without sourcePath');
    assert.ok(posted);
    assert.strictEqual(posted.source_path, null);
  });

  it('should close ledger', () => {
    closeLedger(ledger);
  });
});
