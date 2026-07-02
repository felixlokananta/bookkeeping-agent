/**
 * Unit tests for the invoicing extension.
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
  resolveAccount,
  type Ledger,
} from '../.pi/extensions/bookkeeping/ledger.ts';
import { toMinor, toMajor, formatMoney } from '../.pi/extensions/bookkeeping/money.ts';
import {
  createInvoice,
  listInvoices,
  recordPayment,
  computeInvoiceStatus,
  type CreateInvoiceOpts,
} from '../.pi/extensions/invoicing/invoices.ts';
import { nextInvoiceNumber, loadInvoiceByNumber } from '../.pi/extensions/invoicing/store.ts';
import { arAging } from '../.pi/extensions/invoicing/aging.ts';
import { renderInvoice } from '../.pi/extensions/invoicing/render.ts';

describe('Invoicing Extension Tests', () => {
  let ledger: Ledger;
  let tmpDir: string;

  before(() => {
    // Isolate anomaly-log, vendor rules, and invoices directory from the real memory/ files
    tmpDir = mkdtempSync(join(tmpdir(), 'invoicing-test-'));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, 'anomaly_log.json');
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, 'vendor_rules.json');
    process.env.BOOKKEEPING_INVOICES_DIR = join(tmpDir, 'invoices');
  });

  after(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    delete process.env.BOOKKEEPING_VENDOR_RULES_PATH;
    delete process.env.BOOKKEEPING_INVOICES_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up env
    delete process.env.BOOKKEEPING_DB_PATH;

    // Open in-memory ledger
    ledger = openLedger(':memory:');

    // Create necessary accounts
    createAccount(ledger, { name: 'Assets:Checking' });
    createAccount(ledger, { name: 'Income:Services' });
  });

  afterEach(() => {
    if (ledger) {
      closeLedger(ledger);
    }
    // Clean up invoices directory between tests to ensure isolation
    const invoicesDir = process.env.BOOKKEEPING_INVOICES_DIR;
    if (invoicesDir) {
      try {
        rmSync(invoicesDir, { recursive: true, force: true });
      } catch {
        // Directory may not exist yet
      }
    }
  });

  describe('createInvoice', () => {
    it('should compute correct total from multiple line items', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Acme Corp',
        lineItems: [
          { description: 'Widget A', quantity: 2, unitPrice: 50.0 },
          { description: 'Widget B', quantity: 3, unitPrice: 25.50 },
        ],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      // Total should be (2 * 50.0) + (3 * 25.50) = 100 + 76.50 = 176.50
      assert.strictEqual(invoice.totalMinor, toMinor(176.50));
      assert.strictEqual(toMajor(invoice.totalMinor), 176.50);
    });

    it('should post a balanced 2-split transaction', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Test Customer',
        lineItems: [{ description: 'Test Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      // Fetch the transaction to verify splits
      const tx = ledger.db
        .prepare('SELECT * FROM transactions WHERE id = ?')
        .get(invoice.transactionId) as any;
      assert(tx);

      const splits = ledger.db
        .prepare('SELECT * FROM splits WHERE transaction_id = ? ORDER BY id')
        .all(invoice.transactionId) as any[];
      assert.strictEqual(splits.length, 2);

      // Sum of splits should be zero (balanced)
      const sum = splits.reduce((acc, s) => acc + s.amount, 0);
      assert.strictEqual(sum, 0);

      // One split debits AR, one credits income
      const arSplit = splits.find((s) => s.amount > 0);
      const incomeSplit = splits.find((s) => s.amount < 0);
      assert(arSplit);
      assert(incomeSplit);
      assert.strictEqual(arSplit.amount, toMinor(100.0));
      assert.strictEqual(incomeSplit.amount, -toMinor(100.0));
    });

    it('should auto-create AR and income accounts', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'New Customer',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:NewCategory',
      };

      // AR account should not exist yet
      assert.throws(() => resolveAccount(ledger, 'Assets:Accounts Receivable:New Customer'));

      const invoice = createInvoice(ledger, opts);

      // Both accounts should now exist
      const arAccount = resolveAccount(ledger, 'Assets:Accounts Receivable:New Customer');
      assert(arAccount);
      const incomeAccount = resolveAccount(ledger, 'Income:NewCategory');
      assert(incomeAccount);
    });

    it('should be blocked without approved above the auto-post limit', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Big Customer',
        lineItems: [{ description: 'Expensive Item', quantity: 1, unitPrice: 10000.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
        approved: false,
      };

      assert.throws(
        () => createInvoice(ledger, opts),
        /exceeds auto-post limit/i
      );
    });

    it('should succeed with approved flag above the auto-post limit', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Big Customer',
        lineItems: [{ description: 'Expensive Item', quantity: 1, unitPrice: 10000.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
        approved: true,
      };

      const invoice = createInvoice(ledger, opts);
      assert(invoice.invoiceNumber);
      assert.strictEqual(invoice.status, 'open');
    });

    it('should persist invoice JSON with expected fields', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Save Test',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      // Load from disk and verify
      const loaded = loadInvoiceByNumber(invoice.invoiceNumber);
      assert.strictEqual(loaded.customer, 'Save Test');
      assert.strictEqual(loaded.invoiceNumber, invoice.invoiceNumber);
      assert.strictEqual(loaded.totalMinor, toMinor(100.0));
      assert(loaded.filePath);
      assert(loaded.transactionId);
      assert(loaded.createdAt);
    });

    it('should set transaction source_path to the invoice file path', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Source Path Test',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      // Fetch the transaction and check source_path
      const tx = ledger.db
        .prepare('SELECT * FROM transactions WHERE id = ?')
        .get(invoice.transactionId) as any;
      assert.strictEqual(tx.source_path, invoice.filePath);
    });

    it('should reject a negative quantity line item', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Negative Qty Customer',
        lineItems: [{ description: 'Refund-ish item', quantity: -1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      assert.throws(() => createInvoice(ledger, opts), /quantity > 0/i);
    });

    it('should reject a negative unit price line item', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Negative Price Customer',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: -50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      assert.throws(() => createInvoice(ledger, opts), /unitPrice >= 0/i);
    });

    it('should reject a customer name containing a colon', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Smith:LLC',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      assert.throws(() => createInvoice(ledger, opts), /must not contain ':'/);
    });

    it('should reject an empty line items array', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Empty Items Customer',
        lineItems: [],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      assert.throws(() => createInvoice(ledger, opts), /at least one line item/i);
    });

    it('should keep rendered line totals consistent with the grand total for fractional-cent unit prices', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Rounding Customer',
        lineItems: [{ description: 'Hourly work', quantity: 3, unitPrice: 19.995 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);
      const rendered = renderInvoice(invoice);

      // Sum of the per-line totals, recomputed exactly the way render.ts
      // does, must equal invoice.totalMinor (no independent rounding path).
      const lineTotal = Math.round(3 * toMinor(19.995));
      assert.strictEqual(lineTotal, invoice.totalMinor);

      // The single line item's total and the grand total must print as the
      // same dollar figure in the rendered output (there's only one line item).
      const expected = formatMoney(invoice.totalMinor);
      const occurrences = rendered.split(expected).length - 1;
      assert(occurrences >= 2, `expected "${expected}" to appear at least twice (line total + grand total) in:\n${rendered}`);
    });
  });

  describe('Invoice numbering', () => {
    it('should generate sequential invoice numbers within a year', () => {
      const opts1: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice1 = createInvoice(ledger, opts1);
      assert.strictEqual(invoice1.invoiceNumber, 'INV-2026-0001');

      const opts2: CreateInvoiceOpts = {
        customer: 'Customer B',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-02',
        dueDate: '2026-08-02',
        incomeAccount: 'Income:Services',
      };

      const invoice2 = createInvoice(ledger, opts2);
      assert.strictEqual(invoice2.invoiceNumber, 'INV-2026-0002');
    });

    it('should reset sequence for a different year', () => {
      const opts1: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice1 = createInvoice(ledger, opts1);
      assert.strictEqual(invoice1.invoiceNumber, 'INV-2026-0001');

      const opts2: CreateInvoiceOpts = {
        customer: 'Customer B',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2027-01-01',
        dueDate: '2027-02-01',
        incomeAccount: 'Income:Services',
      };

      const invoice2 = createInvoice(ledger, opts2);
      assert.strictEqual(invoice2.invoiceNumber, 'INV-2027-0001');
    });
  });

  describe('loadInvoiceByNumber', () => {
    it('should throw "not found" for a plain unknown invoice number', () => {
      assert.throws(() => loadInvoiceByNumber('INV-2026-9999'), /not found/i);
    });

    it('should reject path-traversal-shaped input instead of resolving outside the invoices directory', () => {
      assert.throws(() => loadInvoiceByNumber('../../../../../../etc/passwd'), /not found/i);
      assert.throws(() => loadInvoiceByNumber('../secret'), /not found/i);
    });

    it('should reject an invoice number that does not match INV-YYYY-NNNN', () => {
      assert.throws(() => loadInvoiceByNumber('not-an-invoice-number'), /not found/i);
      assert.throws(() => loadInvoiceByNumber('INV-26-1'), /not found/i);
    });
  });

  describe('listInvoices / status derivation', () => {
    it('should show open status for invoice with no payments', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      createInvoice(ledger, opts);

      const invoices = listInvoices(ledger, { asOf: '2026-07-15' });
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, 'open');
      assert.strictEqual(invoices[0].remaining, toMinor(100.0));
      assert.strictEqual(invoices[0].paidToDate, 0);
    });

    it('should show partially paid status', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 60.0,
        date: '2026-07-10',
      });

      const invoices = listInvoices(ledger, { asOf: '2026-07-15' });
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, 'partially paid');
      assert.strictEqual(invoices[0].remaining, toMinor(40.0));
      assert.strictEqual(invoices[0].paidToDate, toMinor(60.0));
    });

    it('should show paid status', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      const invoice = createInvoice(ledger, opts);

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 100.0,
        date: '2026-07-10',
      });

      const invoices = listInvoices(ledger, { asOf: '2026-07-15' });
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, 'paid');
      assert.strictEqual(invoices[0].remaining, 0);
      assert.strictEqual(invoices[0].paidToDate, toMinor(100.0));
    });

    it('should show overdue status', () => {
      const opts: CreateInvoiceOpts = {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      };

      createInvoice(ledger, opts);

      const invoices = listInvoices(ledger, { asOf: '2026-08-15' });
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, 'overdue');
    });

    it('should filter by customer', () => {
      createInvoice(ledger, {
        customer: 'Acme',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      createInvoice(ledger, {
        customer: 'Widget Inc',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const acmeInvoices = listInvoices(ledger, { customer: 'Acme' });
      assert.strictEqual(acmeInvoices.length, 1);
      assert.strictEqual(acmeInvoices[0].customer, 'Acme');

      const widgetInvoices = listInvoices(ledger, { customer: 'Widget Inc' });
      assert.strictEqual(widgetInvoices.length, 1);
      assert.strictEqual(widgetInvoices[0].customer, 'Widget Inc');
    });

    it('should filter by status', () => {
      const inv1 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const inv2 = createInvoice(ledger, {
        customer: 'Customer B',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 50.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      // Pay invoice 2 in full
      recordPayment(ledger, {
        invoiceNumber: inv2.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 50.0,
        date: '2026-07-10',
      });

      const paidInvoices = listInvoices(ledger, { status: 'paid', asOf: '2026-07-15' });
      assert.strictEqual(paidInvoices.length, 1);
      assert.strictEqual(paidInvoices[0].invoiceNumber, inv2.invoiceNumber);

      const openInvoices = listInvoices(ledger, { status: 'open', asOf: '2026-07-15' });
      assert.strictEqual(openInvoices.length, 1);
      assert.strictEqual(openInvoices[0].invoiceNumber, inv1.invoiceNumber);
    });
  });

  describe('recordPayment', () => {
    it('should post correct debit bank / credit AR transaction', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 50.0,
        date: '2026-07-10',
      });

      // Verify the splits
      const splits = ledger.db
        .prepare('SELECT * FROM splits WHERE amount != ? ORDER BY id DESC LIMIT 2')
        .all(0) as any[];
      assert.strictEqual(splits.length, 2);

      // Most recent split should be credit to AR (negative)
      // Previous should be debit to bank (positive)
      const bankSplit = splits.find((s) => s.amount > 0);
      const arSplit = splits.find((s) => s.amount < 0);
      assert(bankSplit);
      assert(arSplit);
      assert.strictEqual(bankSplit.amount, toMinor(50.0));
      assert.strictEqual(arSplit.amount, -toMinor(50.0));
    });

    it('should accumulate multiple partial payments', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 30.0,
        date: '2026-07-10',
      });

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 40.0,
        date: '2026-07-20',
      });

      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 30.0,
        date: '2026-08-01',
      });

      const invoices = listInvoices(ledger, { asOf: '2026-08-15' });
      assert.strictEqual(invoices.length, 1);
      assert.strictEqual(invoices[0].status, 'paid');
      assert.strictEqual(invoices[0].paidToDate, toMinor(100.0));
    });

    it('should throw on unknown invoice number', () => {
      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: 'INV-2026-9999',
            bankAccount: 'Assets:Checking',
            amount: 50.0,
            date: '2026-07-10',
          }),
        /not found/i
      );
    });

    it('should throw if bank account does not exist', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: invoice.invoiceNumber,
            bankAccount: 'Assets:NonExistent',
            amount: 50.0,
            date: '2026-07-10',
          }),
        /not found/i
      );
    });

    it('should inherit the auto-post threshold gate', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 10000.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
        approved: true,
      });

      // Large payment should be blocked without approved flag
      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: invoice.invoiceNumber,
            bankAccount: 'Assets:Checking',
            amount: 5000.0,
            date: '2026-07-10',
            approved: false,
          }),
        /exceeds auto-post limit/i
      );

      // Should succeed with approved flag
      recordPayment(ledger, {
        invoiceNumber: invoice.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 5000.0,
        date: '2026-07-10',
        approved: true,
      });
    });

    it('should reject a zero or negative payment amount', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: invoice.invoiceNumber,
            bankAccount: 'Assets:Checking',
            amount: 0,
            date: '2026-07-10',
          }),
        /amount must be > 0/i
      );

      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: invoice.invoiceNumber,
            bankAccount: 'Assets:Checking',
            amount: -20,
            date: '2026-07-10',
          }),
        /amount must be > 0/i
      );
    });

    it('should reject an invoice number that does not match the expected format (path traversal guard)', () => {
      assert.throws(
        () =>
          recordPayment(ledger, {
            invoiceNumber: '../../../../etc/passwd',
            bankAccount: 'Assets:Checking',
            amount: 50.0,
            date: '2026-07-10',
          }),
        /not found/i
      );
    });
  });

  describe('renderInvoice', () => {
    it('should output contain customer, number, items, total, and status', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Acme Corp',
        lineItems: [
          { description: 'Widget A', quantity: 2, unitPrice: 50.0 },
          { description: 'Widget B', quantity: 1, unitPrice: 25.0 },
        ],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const invoiceWithStatus = listInvoices(ledger, { asOf: '2026-07-15' })[0];
      const rendered = renderInvoice(invoiceWithStatus);

      assert(rendered.includes('Acme Corp'));
      assert(rendered.includes('INV-2026-0001'));
      assert(rendered.includes('Widget A'));
      assert(rendered.includes('Widget B'));
      assert(rendered.includes('125.00')); // total
      assert(rendered.includes('OPEN')); // status
    });
  });

  describe('arAging', () => {
    it('should correctly bucket outstanding invoices by days outstanding', () => {
      // Create invoices at different dates
      const inv1 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const inv2 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 200.0 }],
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        incomeAccount: 'Income:Services',
      });

      const inv3 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 300.0 }],
        issueDate: '2026-04-01',
        dueDate: '2026-05-01',
        incomeAccount: 'Income:Services',
      });

      const report = arAging(ledger, { asOf: '2026-07-31' });

      // inv1: 30 days outstanding (0-30)
      // inv2: 60 days outstanding (31-60)
      // inv3: 121 days outstanding (90+)
      assert.strictEqual(report.byCustomer.length, 1);
      assert.strictEqual(report.byCustomer[0].customer, 'Customer A');
      assert.strictEqual(report.byCustomer[0].buckets['0-30'].count, 1);
      assert.strictEqual(report.byCustomer[0].buckets['31-60'].count, 1);
      assert.strictEqual(report.byCustomer[0].buckets['90+'].count, 1);
    });

    it('should exclude fully-paid invoices', () => {
      const inv1 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const inv2 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 200.0 }],
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        incomeAccount: 'Income:Services',
      });

      // Pay invoice 1 in full
      recordPayment(ledger, {
        invoiceNumber: inv1.invoiceNumber,
        bankAccount: 'Assets:Checking',
        amount: 100.0,
        date: '2026-07-10',
      });

      const report = arAging(ledger, { asOf: '2026-07-31' });

      // Only inv2 should appear (outstanding)
      assert.strictEqual(report.byCustomer.length, 1);
      assert.strictEqual(report.byCustomer[0].buckets['31-60'].count, 1);
      assert.strictEqual(report.byCustomer[0].buckets['31-60'].totalMinor, toMinor(200.0));
    });

    it('should compute per-customer and grand totals correctly', () => {
      const inv1 = createInvoice(ledger, {
        customer: 'Customer A',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const inv2 = createInvoice(ledger, {
        customer: 'Customer B',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 150.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      const report = arAging(ledger, { asOf: '2026-07-31' });

      // 2 customers, each with one invoice in 0-30 bucket
      assert.strictEqual(report.byCustomer.length, 2);
      assert.strictEqual(report.byCustomer[0].buckets['0-30'].count, 1);
      assert.strictEqual(report.byCustomer[1].buckets['0-30'].count, 1);

      // Grand totals should sum correctly
      assert.strictEqual(report.grandTotals.total.count, 2);
      assert.strictEqual(report.grandTotals.total.totalMinor, toMinor(250.0));
    });
  });

  describe('Environment isolation', () => {
    it('should use BOOKKEEPING_INVOICES_DIR from environment', () => {
      const invoice = createInvoice(ledger, {
        customer: 'Test',
        lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100.0 }],
        issueDate: '2026-07-01',
        dueDate: '2026-08-01',
        incomeAccount: 'Income:Services',
      });

      // Invoice should be saved in the temp directory
      const invoicesDir = process.env.BOOKKEEPING_INVOICES_DIR;
      assert(invoicesDir);
      const filePath = invoice.filePath;
      assert(filePath.startsWith(invoicesDir));
    });
  });
});
