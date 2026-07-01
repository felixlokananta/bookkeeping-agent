/**
 * Pi extension: receipt_ocr image capture tools.
 * Registers two tools: read_receipt, capture_receipt.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as bookkeeping/index.ts and bank_sync/index.ts).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { toMinor, toMajor } from '../bookkeeping/money.ts';
import { loadReceiptImage, postReceiptEntry } from './capture.ts';

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

  // Tool: read_receipt
  pi.registerTool({
    name: 'read_receipt',
    label: 'Read Receipt',
    description:
      'Load a receipt or invoice image from disk and return it as vision content for LLM extraction.',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path to the receipt image file (e.g. "data/inbox/receipt1.jpg"), resolved from cwd. ' +
          'Supported formats: PNG, JPG, JPEG, GIF, WebP. PDF not yet supported.',
      }),
    }),
    promptSnippet: '`read_receipt` — load a receipt image for extraction',
    promptGuidelines: [
      'Always call `read_receipt` before `capture_receipt`; never guess receipt contents from the filename alone.',
      'After reading the image, state the extracted date, total amount, vendor/payee, and any line items in chat.',
      'Get operator confirmation on all extracted fields before calling `capture_receipt`.',
      '.pdf files are not supported yet; ask the operator to provide an image export (PNG, JPG, etc.) instead.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      try {
        const { data, mimeType } = await loadReceiptImage(params.path);

        return {
          content: [
            { type: 'image', data, mimeType },
            {
              type: 'text',
              text: 'Extract the following from the receipt:\n' +
                '1. Date (YYYY-MM-DD format)\n' +
                '2. Total amount (include currency sign and decimal places)\n' +
                '3. Vendor/payee name\n' +
                '4. Line items (if visible) with amounts\n' +
                'State your findings and note any fields you are unsure about (blurry, missing, etc.).',
            },
          ],
          details: { path: params.path },
        };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });

  // Tool: capture_receipt
  pi.registerTool({
    name: 'capture_receipt',
    label: 'Capture Receipt',
    description:
      'Post a confirmed receipt extraction as a balanced double-entry transaction against an Uncategorized account.',
    parameters: Type.Object({
      date: Type.String({ description: 'Transaction date (YYYY-MM-DD)' }),
      amount: Type.Number({
        description:
          'Total amount in major units (dollars), signed: negative = expense (money out), ' +
          'positive = income. Same sign convention as log_transaction and post_transaction.',
      }),
      account: Type.String({
        description: 'Source account (e.g. "Assets:Checking"). The receipt is posted against this account.',
      }),
      payee: Type.String({
        description: 'Vendor or payer name (stored as the transaction description).',
      }),
      source_path: Type.String({
        description: 'Path to the receipt image file (the same path passed to read_receipt).',
      }),
      memo: Type.Optional(
        Type.String({
          description:
            'Optional free-text memo. Use this for line items (if extracted) and any additional notes.',
        })
      ),
      confidence: Type.Union([Type.Literal('high'), Type.Literal('low')], {
        description:
          "Agent's self-assessment of extraction quality. 'low' blocks posting unless force: true.",
      }),
      uncertain_fields: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Array of field names (e.g. ["date", "amount"]) the agent is uncertain about. ' +
            'Only used if confidence: "low".',
        })
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to override low-confidence block and force posting. ' +
            'Only used if confidence: "low". Default: false.',
        })
      ),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to approve posting if the transaction exceeds the auto-post limit. Default: false.',
        })
      ),
    }),
    promptSnippet: '`capture_receipt` — post the confirmed receipt extraction',
    promptGuidelines: [
      'State the extracted date/amount/payee/line-items in chat and get operator confirmation before calling this tool.',
      'Set confidence: "low" and list uncertain_fields if the image is blurry, cropped, or any field cannot be read clearly. ' +
        'Do not guess a value and mark it "high".',
      'If confidence: "low" and the operator does not confirm the uncertain values, do not call this tool.',
      'If confidence: "low", the post will be blocked and you will be instructed to re-call with force: true after ' +
        'operator confirmation.',
      'Amount sign matches log_transaction: negative = expense (out), positive = income (in).',
      'The offsetting account (Expenses:Uncategorized or Income:Uncategorized) is inferred automatically.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const amountMinor = toMinor(params.amount);
      const result = postReceiptEntry(ledger, {
        date: params.date,
        amountMinor,
        account: params.account,
        payee: params.payee,
        memo: params.memo,
        sourcePath: params.source_path,
        confidence: params.confidence,
        uncertainFields: params.uncertain_fields,
        force: params.force ?? false,
        approved: params.approved ?? false,
      });

      // Low-confidence block: throw with instructions
      if ('lowConfidence' in result) {
        const fields = result.lowConfidence.join(', ');
        throw new Error(
          `Low-confidence extraction blocked. Uncertain fields: ${fields}. ` +
            `Please confirm with the user that these values are correct, then re-call ` +
            `with force: true to post anyway.`
        );
      }

      // Success: return transaction details
      const text = `Captured receipt ${result.transactionId} on ${params.date}: ${params.payee} (${params.source_path})`;
      return {
        content: [{ type: 'text', text }],
        details: { transactionId: result.transactionId, splitIds: result.splitIds },
      };
    },
  });
}
