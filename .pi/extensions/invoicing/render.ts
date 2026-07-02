/**
 * Invoice rendering: pi-agnostic, unit-testable.
 * Renders an invoice as plain text/markdown.
 */

import { formatMoney } from '../bookkeeping/money.ts';
import { lineItemTotalMinor } from './store.ts';
import type { InvoiceWithStatus } from './invoices.ts';

/**
 * Render an invoice as plain text/markdown.
 * Output includes invoice number, customer, dates, line items, total, and status.
 */
export function renderInvoice(invoice: InvoiceWithStatus): string {
  const lineSeparator = '─'.repeat(80);

  // Header
  let text = `${lineSeparator}\n`;
  text += `INVOICE ${invoice.invoiceNumber}\n`;
  text += `${lineSeparator}\n\n`;

  // Customer and dates
  text += `Bill To: ${invoice.customer}\n`;
  text += `Issue Date: ${invoice.issueDate}\n`;
  text += `Due Date: ${invoice.dueDate}\n`;
  text += `Status: ${invoice.status.toUpperCase()}\n\n`;

  // Line items table
  text += `Description                              Qty     Unit Price    Line Total\n`;
  text += `${'-'.repeat(80)}\n`;

  for (const item of invoice.lineItems) {
    // Same helper used by invoices.ts to derive invoice.totalMinor, so the
    // line items printed here always sum to the grand total below.
    const lineTotalMinor = lineItemTotalMinor(item.quantity, item.unitPrice);

    const description = item.description.substring(0, 38).padEnd(38);
    const qty = String(item.quantity).padStart(5);
    const unitPrice = formatMoney(item.unitPrice).padStart(11);
    const lineTotal = formatMoney(lineTotalMinor).padStart(12);

    text += `${description}${qty}${unitPrice}${lineTotal}\n`;
  }

  text += `${'-'.repeat(80)}\n`;

  // Grand total
  const grandTotalStr = formatMoney(invoice.totalMinor).padStart(68);
  text += `TOTAL:${grandTotalStr}\n\n`;

  // Payment summary
  if (invoice.paidToDate > 0) {
    const paidStr = formatMoney(invoice.paidToDate).padStart(68);
    text += `Amount Paid:${paidStr}\n`;
  }

  if (invoice.remaining !== invoice.totalMinor) {
    const remainingStr = formatMoney(invoice.remaining).padStart(68);
    text += `Amount Remaining:${remainingStr}\n`;
  }

  text += `\n${lineSeparator}\n`;

  return text;
}
