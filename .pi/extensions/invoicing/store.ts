/**
 * Invoice storage and numbering: pi-agnostic, unit-testable.
 * Invoices are stored as one JSON file per invoice in a directory.
 * Path defaults to memory/invoices/, overridable via BOOKKEEPING_INVOICES_DIR env var.
 *
 * Numbering: INV-<YYYY>-<NNNN> where YYYY is the invoice's year and NNNN
 * is the sequence number (resets per year).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number; // in minor units (cents)
}

/**
 * Compute a line item's total in minor units from a quantity and a
 * minor-unit unit price. Single source of truth for this multiplication so
 * invoice totals (invoices.ts) and rendered line totals (render.ts) can
 * never disagree due to independently-rounded paths to the same number.
 */
export function lineItemTotalMinor(quantity: number, unitPriceMinor: number): number {
  return Math.round(quantity * unitPriceMinor);
}

const INVOICE_NUMBER_RE = /^INV-\d{4}-\d{4}$/;

export interface Invoice {
  invoiceNumber: string; // e.g. "INV-2026-0001"
  customer: string;
  lineItems: LineItem[];
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  incomeAccount: string; // e.g. "Income:Services"
  totalMinor: number; // sum of all line items in cents
  transactionId: number; // ledger transaction ID
  filePath: string; // full path to the JSON file
  createdAt: number; // milliseconds since epoch
}

/**
 * Resolve the invoices directory path.
 * Defaults to memory/invoices/, overridable via BOOKKEEPING_INVOICES_DIR.
 * Creates the directory if it doesn't exist.
 */
export function resolveInvoicesDir(): string {
  const dir = process.env.BOOKKEEPING_INVOICES_DIR || resolve('./memory/invoices');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compute the next invoice number for a given year.
 * Scans the invoices directory for existing invoices of the form INV-<year>-*.json,
 * finds the highest sequence number, and returns the next one (padded to 4 digits).
 *
 * If no invoices exist for that year, starts at 0001.
 */
export function nextInvoiceNumber(issueDate: string): string {
  const year = issueDate.split('-')[0];
  const dir = resolveInvoicesDir();

  let maxSeq = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(new RegExp(`^INV-${year}-(\\d{4})\\.json$`));
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq > maxSeq) {
          maxSeq = seq;
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read; this is fine
  }

  const nextSeq = maxSeq + 1;
  return `INV-${year}-${String(nextSeq).padStart(4, '0')}`;
}

/**
 * Load an invoice by number from disk.
 * Throws if not found, including when invoiceNumber doesn't match the
 * expected INV-YYYY-NNNN format — this is user-controlled input used to
 * build a filesystem path, so malformed/path-traversal input (e.g.
 * "../../../etc/passwd") is rejected before it ever reaches `resolve()`.
 */
export function loadInvoiceByNumber(invoiceNumber: string): Invoice {
  if (!INVOICE_NUMBER_RE.test(invoiceNumber)) {
    throw new Error(`Invoice not found: ${invoiceNumber}`);
  }

  const dir = resolveInvoicesDir();
  const filePath = resolve(dir, `${invoiceNumber}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const invoice = JSON.parse(content) as Invoice;
    return invoice;
  } catch {
    throw new Error(`Invoice not found: ${invoiceNumber}`);
  }
}

/**
 * Save an invoice to disk.
 * Creates the file with the given invoice data.
 */
export function saveInvoice(invoice: Invoice): void {
  const dir = resolveInvoicesDir();
  const filePath = resolve(dir, `${invoice.invoiceNumber}.json`);

  writeFileSync(filePath, JSON.stringify(invoice, null, 2), 'utf-8');
}

/**
 * List all invoices from disk.
 * Reads all INV-*.json files from the invoices directory and returns them.
 * Returns empty array if directory is empty or doesn't exist.
 */
export function listAllInvoices(): Invoice[] {
  const dir = resolveInvoicesDir();
  const invoices: Invoice[] = [];

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (file.match(/^INV-\d{4}-\d{4}\.json$/)) {
        try {
          const content = readFileSync(resolve(dir, file), 'utf-8');
          const invoice = JSON.parse(content) as Invoice;
          invoices.push(invoice);
        } catch {
          // Skip invalid files
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read; return empty array
  }

  return invoices;
}
