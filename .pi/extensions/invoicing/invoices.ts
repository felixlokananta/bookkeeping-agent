/**
 * Core invoicing logic: pi-agnostic, unit-testable.
 * Handles invoice creation, listing with status derivation, and payment recording.
 *
 * Invoices are backed by double-entry transactions in the ledger (no schema changes).
 * Status is computed from transaction linkage via source_path, not stored.
 */

import { resolve } from 'path';
import type { Ledger } from '../bookkeeping/ledger.ts';
import { createAccount, resolveAccount, postTransaction } from '../bookkeeping/ledger.ts';
import { toMinor, toMajor } from '../bookkeeping/money.ts';
import {
  nextInvoiceNumber,
  saveInvoice,
  loadInvoiceByNumber,
  listAllInvoices,
  resolveInvoicesDir,
  lineItemTotalMinor,
  type Invoice,
} from './store.ts';

export type InvoiceStatus = 'open' | 'partially paid' | 'paid' | 'overdue';

export interface InvoiceWithStatus extends Invoice {
  status: InvoiceStatus;
  remaining: number; // remaining amount in minor units (cents)
  paidToDate: number; // total paid to date in minor units (cents)
}

/**
 * Compute the status of an invoice as of a given date.
 * Queries the AR account for splits linked to this invoice (by source_path).
 * Returns status, remaining amount, and paid-to-date.
 */
export function computeInvoiceStatus(
  ledger: Ledger,
  invoice: Invoice,
  asOf: string
): {
  status: InvoiceStatus;
  remaining: number;
  paidToDate: number;
} {
  const db = ledger.db;

  // Resolve the AR account for this customer
  const arAccountName = `Assets:Accounts Receivable:${invoice.customer}`;
  let arAccountId: number | null = null;
  try {
    const arAccount = resolveAccount(ledger, arAccountName);
    arAccountId = arAccount.id;
  } catch {
    // AR account doesn't exist yet (no payments have been made)
    arAccountId = null;
  }

  // Query splits on the AR account linked to this invoice (by source_path)
  // and only include transactions dated on or before asOf.
  let paidMinor = 0;
  if (arAccountId !== null) {
    const query = `
      SELECT COALESCE(SUM(s.amount), 0) as total
      FROM splits s
      JOIN transactions t ON t.id = s.transaction_id
      WHERE s.account_id = ?
        AND t.source_path = ?
        AND t.date <= ?
        AND s.amount < 0
    `;
    const result = db.prepare(query).get(arAccountId, invoice.filePath, asOf) as { total: number };
    paidMinor = -result.total; // Negate because credits are negative
    // Ensure we don't return -0
    if (paidMinor === 0) {
      paidMinor = 0;
    }
  }

  const remainingMinor = invoice.totalMinor - paidMinor;

  // Determine status
  let status: InvoiceStatus;
  const isPaid = remainingMinor <= 0;
  const isOverdue = asOf > invoice.dueDate && remainingMinor > 0;

  if (isPaid) {
    status = 'paid';
  } else if (remainingMinor === invoice.totalMinor) {
    status = isOverdue ? 'overdue' : 'open';
  } else {
    status = isOverdue ? 'overdue' : 'partially paid';
  }

  return {
    status,
    remaining: remainingMinor,
    paidToDate: paidMinor,
  };
}

export interface CreateInvoiceOpts {
  customer: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number; // in major units (dollars)
  }>;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  incomeAccount: string; // e.g. "Income:Services"
  approved?: boolean;
}

/**
 * Create an invoice and post a balanced transaction to the ledger.
 * - Computes invoice number (INV-<year>-<seq>)
 * - Ensures AR and income accounts exist (auto-create if needed)
 * - Posts a transaction: debit AR, credit income
 * - Sets transaction source_path to the invoice file path
 * - Persists invoice JSON
 * - Throws if transaction is blocked by auto-post limit (unless approved)
 */
export function createInvoice(
  ledger: Ledger,
  opts: CreateInvoiceOpts
): InvoiceWithStatus {
  const { customer, lineItems, issueDate, dueDate, incomeAccount, approved } = opts;

  if (customer.includes(':')) {
    throw new Error(
      `Customer name must not contain ':' (would create an unintended nested account under Assets:Accounts Receivable): ${customer}`
    );
  }

  if (lineItems.length === 0) {
    throw new Error('Invoice must have at least one line item');
  }
  for (const [i, item] of lineItems.entries()) {
    if (!(item.quantity > 0)) {
      throw new Error(`Line item ${i} ("${item.description}") must have quantity > 0, got: ${item.quantity}`);
    }
    if (!(item.unitPrice >= 0)) {
      throw new Error(`Line item ${i} ("${item.description}") must have unitPrice >= 0, got: ${item.unitPrice}`);
    }
  }

  // Compute total from line items. Each line's minor-unit total is derived
  // from the already-rounded per-unit minor price via lineItemTotalMinor,
  // the same helper render.ts uses for display — so the printed grand total
  // can never disagree with the sum of the printed line totals.
  const totalMinor = lineItems.reduce((sum, item) => {
    return sum + lineItemTotalMinor(item.quantity, toMinor(item.unitPrice));
  }, 0);

  // Compute invoice number
  const invoiceNumber = nextInvoiceNumber(issueDate);

  // Compute file path (we need this before posting because it's the source_path)
  const invoicesDir = resolveInvoicesDir();
  const filePath = resolve(invoicesDir, `${invoiceNumber}.json`);

  // Ensure AR account exists
  const arAccountName = `Assets:Accounts Receivable:${customer}`;
  try {
    resolveAccount(ledger, arAccountName);
  } catch {
    createAccount(ledger, { name: arAccountName, type: 'asset' });
  }

  // Ensure income account exists
  try {
    resolveAccount(ledger, incomeAccount);
  } catch {
    createAccount(ledger, { name: incomeAccount, type: 'income' });
  }

  // Post the transaction: debit AR, credit income
  const { transactionId } = postTransaction(ledger, {
    date: issueDate,
    description: `Invoice ${invoiceNumber} - ${customer}`,
    splits: [
      {
        account: arAccountName,
        amount: totalMinor, // debit
      },
      {
        account: incomeAccount,
        amount: -totalMinor, // credit
      },
    ],
    sourcePath: filePath,
    approved,
  });

  // Create and save invoice
  const invoice: Invoice = {
    invoiceNumber,
    customer,
    lineItems: lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: toMinor(item.unitPrice),
    })),
    issueDate,
    dueDate,
    incomeAccount,
    totalMinor,
    transactionId,
    filePath,
    createdAt: Date.now(),
  };

  saveInvoice(invoice);

  // Compute status (as of issueDate, so it's open)
  const statusInfo = computeInvoiceStatus(ledger, invoice, issueDate);

  return {
    ...invoice,
    status: statusInfo.status,
    remaining: statusInfo.remaining,
    paidToDate: statusInfo.paidToDate,
  };
}

export interface ListInvoicesOpts {
  customer?: string;
  status?: InvoiceStatus;
  asOf?: string;
}

/**
 * List invoices from disk, optionally filtered by customer or status.
 * Computes status as of the given date (defaults to today).
 */
export function listInvoices(
  ledger: Ledger,
  opts: ListInvoicesOpts = {}
): InvoiceWithStatus[] {
  const { customer, status, asOf = new Date().toISOString().split('T')[0] } = opts;

  let invoices = listAllInvoices();

  // Filter by customer if provided
  if (customer) {
    invoices = invoices.filter((inv) => inv.customer === customer);
  }

  // Compute status and filter by status if provided
  const invoicesWithStatus: InvoiceWithStatus[] = invoices.map((inv) => {
    const statusInfo = computeInvoiceStatus(ledger, inv, asOf);
    return {
      ...inv,
      status: statusInfo.status,
      remaining: statusInfo.remaining,
      paidToDate: statusInfo.paidToDate,
    };
  });

  if (status) {
    return invoicesWithStatus.filter((inv) => inv.status === status);
  }

  return invoicesWithStatus;
}

export interface RecordPaymentOpts {
  invoiceNumber: string;
  bankAccount: string; // e.g. "Assets:Checking"
  amount: number; // in major units (dollars)
  date: string; // YYYY-MM-DD
  memo?: string;
  approved?: boolean;
}

/**
 * Record a payment against an invoice.
 * - Loads the invoice
 * - Throws if invoice not found
 * - Throws if bank account doesn't exist (no auto-create)
 * - Posts a transaction: debit bank, credit AR
 * - Sets transaction source_path to the invoice file path
 * - Throws if transaction blocked by auto-post limit (unless approved)
 */
export function recordPayment(
  ledger: Ledger,
  opts: RecordPaymentOpts
): void {
  const { invoiceNumber, bankAccount, amount, date, memo, approved } = opts;

  if (!(amount > 0)) {
    throw new Error(`Payment amount must be > 0, got: ${amount}`);
  }

  // Load the invoice
  const invoice = loadInvoiceByNumber(invoiceNumber);

  // Verify bank account exists (don't auto-create)
  try {
    resolveAccount(ledger, bankAccount);
  } catch {
    throw new Error(`Bank account not found: ${bankAccount}`);
  }

  // Verify AR account exists (it should if the invoice was created)
  const arAccountName = `Assets:Accounts Receivable:${invoice.customer}`;
  try {
    resolveAccount(ledger, arAccountName);
  } catch {
    throw new Error(`Accounts receivable account not found: ${arAccountName}`);
  }

  // Convert amount to minor units
  const amountMinor = toMinor(amount);

  // Post the transaction: debit bank (increase cash), credit AR (decrease receivable)
  postTransaction(ledger, {
    date,
    description: `Payment for invoice ${invoiceNumber} - ${invoice.customer}`,
    splits: [
      {
        account: bankAccount,
        amount: amountMinor, // debit (increase bank)
        memo,
      },
      {
        account: arAccountName,
        amount: -amountMinor, // credit (decrease AR)
      },
    ],
    sourcePath: invoice.filePath,
    approved,
  });
}
