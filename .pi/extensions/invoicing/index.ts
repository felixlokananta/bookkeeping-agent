/**
 * Pi extension: invoicing tools.
 * Registers five tools: create_invoice, list_invoices, record_payment, render_invoice, ar_aging.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as other extensions).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { toMinor, toMajor, formatMoney } from '../bookkeeping/money.ts';
import {
  createInvoice,
  listInvoices,
  recordPayment,
  type CreateInvoiceOpts,
  type ListInvoicesOpts,
  type RecordPaymentOpts,
} from './invoices.ts';
import { arAging } from './aging.ts';
import { renderInvoice } from './render.ts';

let ledger: Ledger | null = null;

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async () => {
    const dbPath =
      process.env.NODE_ENV === 'test' ? ':memory:' : process.env.BOOKKEEPING_DB_PATH;
    ledger = openLedger(dbPath);
  });

  pi.on('session_shutdown', async () => {
    if (ledger) {
      closeLedger(ledger);
      ledger = null;
    }
  });

  // Tool: create_invoice
  pi.registerTool({
    name: 'create_invoice',
    label: 'Create Invoice',
    description:
      'Create an invoice for a customer. Posts a balanced transaction to the ledger ' +
      '(debiting Accounts Receivable, crediting the specified income account). ' +
      'Auto-creates both accounts if they do not exist. Subject to the auto-post threshold.',
    parameters: Type.Object({
      customer: Type.String({
        description: 'Customer name',
      }),
      lineItems: Type.Array(
        Type.Object({
          description: Type.String({ description: 'Item description' }),
          quantity: Type.Number({ description: 'Quantity' }),
          unitPrice: Type.Number({
            description: 'Unit price in major units (dollars)',
          }),
        }),
        {
          description: 'Array of line items (description, quantity, unitPrice)',
        }
      ),
      issueDate: Type.String({
        description: 'Issue date (YYYY-MM-DD)',
      }),
      dueDate: Type.String({
        description: 'Due date (YYYY-MM-DD)',
      }),
      incomeAccount: Type.String({
        description: 'Income account to credit (e.g. "Income:Services")',
      }),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to override the auto-post threshold. ' +
            'Required if the invoice total exceeds the limit.',
        })
      ),
    }),
    promptSnippet: '`create_invoice` — create and post a customer invoice',
    promptGuidelines: [
      'Invoice number is auto-generated as INV-<YYYY>-<NNNN> based on the issue year and sequence.',
      'The invoice posts a balanced transaction immediately: debit Accounts Receivable, credit the specified income account.',
      'Both accounts are auto-created if they do not exist.',
      'If the total exceeds the auto-post limit, set approved: true after confirming with the user.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const opts: CreateInvoiceOpts = {
        customer: params.customer,
        lineItems: params.lineItems,
        issueDate: params.issueDate,
        dueDate: params.dueDate,
        incomeAccount: params.incomeAccount,
        approved: params.approved ?? false,
      };

      const invoice = createInvoice(ledger, opts);

      const text = `Invoice created: ${invoice.invoiceNumber}
Customer: ${invoice.customer}
Total: ${formatMoney(invoice.totalMinor)}
Issue Date: ${invoice.issueDate}
Due Date: ${invoice.dueDate}
Status: ${invoice.status}`;

      return {
        content: [{ type: 'text', text }],
        details: {
          invoiceNumber: invoice.invoiceNumber,
          customer: invoice.customer,
          totalMinor: invoice.totalMinor,
          totalMajor: toMajor(invoice.totalMinor),
          status: invoice.status,
          remaining: invoice.remaining,
          paidToDate: invoice.paidToDate,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          incomeAccount: invoice.incomeAccount,
          transactionId: invoice.transactionId,
        },
      };
    },
  });

  // Tool: list_invoices
  pi.registerTool({
    name: 'list_invoices',
    label: 'List Invoices',
    description:
      'List invoices with computed status (open, partially paid, paid, overdue). ' +
      'Optionally filter by customer or status. Status is computed as of a given date.',
    parameters: Type.Object({
      customer: Type.Optional(
        Type.String({
          description: 'Filter by customer name',
        })
      ),
      status: Type.Optional(
        Type.Enum(['open', 'partially paid', 'paid', 'overdue'], {
          description: 'Filter by status',
        })
      ),
      asOf: Type.Optional(
        Type.String({
          description: 'Compute status as of this date (YYYY-MM-DD). Default: today.',
        })
      ),
    }),
    promptSnippet: '`list_invoices` — list invoices with computed status and aging',
    promptGuidelines: [
      'Status is computed dynamically based on payments recorded against the invoice.',
      'Pass asOf to see status as of a specific date; omit to use today.',
      'open = full balance outstanding; partially paid = partial payment received; paid = fully paid; overdue = due date passed with remaining balance.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const opts: ListInvoicesOpts = {
        customer: params.customer,
        status: params.status as any,
        asOf: params.asOf,
      };

      const invoices = listInvoices(ledger, opts);

      const lines = ['Invoice Number | Customer | Total | Paid | Remaining | Status | Due Date'];
      lines.push('─'.repeat(100));
      for (const inv of invoices) {
        const line = `${inv.invoiceNumber.padEnd(14)} | ${inv.customer.substring(0, 20).padEnd(20)} | ${formatMoney(inv.totalMinor).padStart(10)} | ${formatMoney(inv.paidToDate).padStart(10)} | ${formatMoney(inv.remaining).padStart(10)} | ${inv.status.padEnd(15)} | ${inv.dueDate}`;
        lines.push(line);
      }

      const text = lines.join('\n');

      return {
        content: [{ type: 'text', text }],
        details: {
          count: invoices.length,
          invoices: invoices.map((inv) => ({
            invoiceNumber: inv.invoiceNumber,
            customer: inv.customer,
            totalMinor: inv.totalMinor,
            totalMajor: toMajor(inv.totalMinor),
            paidToDate: inv.paidToDate,
            paidToDateMajor: toMajor(inv.paidToDate),
            remaining: inv.remaining,
            remainingMajor: toMajor(inv.remaining),
            status: inv.status,
            issueDate: inv.issueDate,
            dueDate: inv.dueDate,
          })),
        },
      };
    },
  });

  // Tool: record_payment
  pi.registerTool({
    name: 'record_payment',
    label: 'Record Invoice Payment',
    description:
      'Record a payment (full or partial) against an invoice. Posts a balanced transaction ' +
      '(debiting the bank account, crediting Accounts Receivable). Throws if the invoice ' +
      'or bank account does not exist. Subject to the auto-post threshold.',
    parameters: Type.Object({
      invoiceNumber: Type.String({
        description: 'Invoice number (e.g. "INV-2026-0001")',
      }),
      bankAccount: Type.String({
        description: 'Bank account to debit (e.g. "Assets:Checking")',
      }),
      amount: Type.Number({
        description: 'Payment amount in major units (dollars)',
      }),
      date: Type.String({
        description: 'Payment date (YYYY-MM-DD)',
      }),
      memo: Type.Optional(
        Type.String({
          description: 'Optional memo/note for the payment',
        })
      ),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to override the auto-post threshold if the payment exceeds the limit.',
        })
      ),
    }),
    promptSnippet: '`record_payment` — record a payment against an invoice',
    promptGuidelines: [
      'Payment can be full or partial; multiple partial payments accumulate toward the invoice total.',
      'The payment is linked to the invoice via source_path, so it appears in status and aging reports.',
      'If the bank account does not exist, throw (no auto-create) — verify the account name first.',
      'If the payment exceeds the auto-post limit, set approved: true after confirming with the user.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const opts: RecordPaymentOpts = {
        invoiceNumber: params.invoiceNumber,
        bankAccount: params.bankAccount,
        amount: params.amount,
        date: params.date,
        memo: params.memo,
        approved: params.approved ?? false,
      };

      recordPayment(ledger, opts);

      const text = `Payment recorded for invoice ${params.invoiceNumber}
Amount: ${formatMoney(toMinor(params.amount))}
Bank Account: ${params.bankAccount}
Date: ${params.date}`;

      return {
        content: [{ type: 'text', text }],
        details: {
          invoiceNumber: params.invoiceNumber,
          amountMinor: toMinor(params.amount),
          amountMajor: params.amount,
          bankAccount: params.bankAccount,
          date: params.date,
        },
      };
    },
  });

  // Tool: render_invoice
  pi.registerTool({
    name: 'render_invoice',
    label: 'Render Invoice',
    description:
      'Render an invoice as formatted plain text. Output includes invoice number, customer, ' +
      'dates, line items, total, payment summary, and current status.',
    parameters: Type.Object({
      invoiceNumber: Type.String({
        description: 'Invoice number (e.g. "INV-2026-0001")',
      }),
      asOf: Type.Optional(
        Type.String({
          description: 'Render status as of this date (YYYY-MM-DD). Default: today.',
        })
      ),
    }),
    promptSnippet: '`render_invoice` — render an invoice as formatted text',
    promptGuidelines: [
      'Output is formatted plain text suitable for printing or sending to a customer.',
      'Status and payment summary are computed as of the specified date (or today if omitted).',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      // Load invoice and compute status
      const allInvoices = listInvoices(ledger, { asOf: params.asOf });
      const invoice = allInvoices.find((inv) => inv.invoiceNumber === params.invoiceNumber);

      if (!invoice) {
        throw new Error(`Invoice not found: ${params.invoiceNumber}`);
      }

      const rendered = renderInvoice(invoice);

      return {
        content: [{ type: 'text', text: rendered }],
        details: {
          invoiceNumber: invoice.invoiceNumber,
          customer: invoice.customer,
          status: invoice.status,
          remaining: invoice.remaining,
        },
      };
    },
  });

  // Tool: ar_aging
  pi.registerTool({
    name: 'ar_aging',
    label: 'AR Aging Report',
    description:
      'Generate an accounts receivable aging report. Buckets outstanding invoices by ' +
      'days outstanding (0-30, 31-60, 61-90, 90+), grouped by customer with totals.',
    parameters: Type.Object({
      asOf: Type.Optional(
        Type.String({
          description: 'Report as of this date (YYYY-MM-DD). Default: today.',
        })
      ),
    }),
    promptSnippet: '`ar_aging` — generate an AR aging report',
    promptGuidelines: [
      'The report shows outstanding (non-paid) invoices only.',
      'Each invoice is bucketed by days from issue date to asOf date.',
      'Results are grouped by customer with per-bucket and grand totals.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const report = arAging(ledger, { asOf: params.asOf });

      let text = `AR Aging Report as of ${report.asOf}\n\n`;

      for (const customer of report.byCustomer) {
        text += `${customer.customer}\n`;
        text += `  0-30 days:   ${customer.buckets['0-30'].count} invoice(s), ${formatMoney(customer.buckets['0-30'].totalMinor)}\n`;
        text += `  31-60 days:  ${customer.buckets['31-60'].count} invoice(s), ${formatMoney(customer.buckets['31-60'].totalMinor)}\n`;
        text += `  61-90 days:  ${customer.buckets['61-90'].count} invoice(s), ${formatMoney(customer.buckets['61-90'].totalMinor)}\n`;
        text += `  90+ days:    ${customer.buckets['90+'].count} invoice(s), ${formatMoney(customer.buckets['90+'].totalMinor)}\n`;
        text += `  Total:       ${formatMoney(customer.totalMinor)}\n\n`;
      }

      text += `Grand Totals:\n`;
      text += `  0-30 days:   ${report.grandTotals['0-30'].count} invoice(s), ${formatMoney(report.grandTotals['0-30'].totalMinor)}\n`;
      text += `  31-60 days:  ${report.grandTotals['31-60'].count} invoice(s), ${formatMoney(report.grandTotals['31-60'].totalMinor)}\n`;
      text += `  61-90 days:  ${report.grandTotals['61-90'].count} invoice(s), ${formatMoney(report.grandTotals['61-90'].totalMinor)}\n`;
      text += `  90+ days:    ${report.grandTotals['90+'].count} invoice(s), ${formatMoney(report.grandTotals['90+'].totalMinor)}\n`;
      text += `  Total:       ${report.grandTotals.total.count} invoice(s), ${formatMoney(report.grandTotals.total.totalMinor)}\n`;

      return {
        content: [{ type: 'text', text }],
        details: report,
      };
    },
  });
}
