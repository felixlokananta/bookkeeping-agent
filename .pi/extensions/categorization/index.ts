/**
 * Pi extension: categorization tools.
 * Registers three tools: list_uncategorized, suggest_category, apply_category.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as bank_sync, same BOOKKEEPING_DB_PATH/:memory: resolution).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { formatMoney } from '../bookkeeping/money.ts';
import {
  listUncategorized,
  suggestCategory,
  applyCategory,
  bulkRecategorize,
} from './categorize.ts';
import { loadRules } from './rules.ts';

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

  // Tool: list_uncategorized
  pi.registerTool({
    name: 'list_uncategorized',
    label: 'List Uncategorized Transactions',
    description:
      'List transactions with splits in Expenses:Uncategorized or Income:Uncategorized, ' +
      'optionally filtered by kind (expense/income) and limited by count.',
    parameters: Type.Object({
      kind: Type.Optional(
        Type.Enum(['expense', 'income'], { description: 'Filter by transaction kind' })
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Max transactions to return. Default: 100.' })
      ),
    }),
    promptSnippet: '`list_uncategorized` — show transactions awaiting categorization',
    promptGuidelines: [
      'Use this to discover which transactions need categorization.',
      'Each transaction shows: date, description/payee, amount, and which Uncategorized account it is in.',
      'Once you have the list, use `suggest_category` or `apply_category` to categorize them.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const results = listUncategorized(ledger, {
        kind: params.kind,
        limit: params.limit,
      });

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No uncategorized transactions found.' }],
          details: { transactions: [] },
        };
      }

      const text =
        `Found ${results.length} uncategorized transaction(s):\n` +
        results
          .map(
            (tx) =>
              `  - [TX ${tx.transactionId}] ${tx.date}: "${tx.description || '(no description)'}" ` +
              `($${formatMoney(tx.amount)}) in ${tx.accountName}`
          )
          .join('\n');

      return {
        content: [{ type: 'text', text }],
        details: { transactions: results },
      };
    },
  });

  // Tool: suggest_category
  pi.registerTool({
    name: 'suggest_category',
    label: 'Suggest Category',
    description:
      'Look up a transaction and suggest a category based on learned vendor rules. ' +
      'Returns high/low confidence with explanation if a rule matches; otherwise prompts agent to infer.',
    parameters: Type.Object({
      transactionId: Type.Number({
        description: 'Transaction ID to look up and suggest a category for',
      }),
    }),
    promptSnippet: '`suggest_category` — get a suggested category for a transaction',
    promptGuidelines: [
      'Use this to see if a learned rule applies to a transaction.',
      'If a rule matches, the response includes confidence (high/low) and which pattern was matched.',
      'If no rule matches, reason over the transaction details (payee, amount, date, description) yourself.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      // Fetch the transaction
      const txSql = `SELECT * FROM transactions WHERE id = ?`;
      const transaction = ledger.db.prepare(txSql).get(params.transactionId) as any;
      if (!transaction) {
        throw new Error(`Transaction ${params.transactionId} not found`);
      }

      // Find the Uncategorized split (payee/memo)
      const splitSql = `
        SELECT s.id, s.memo
        FROM splits s
        JOIN accounts a ON s.account_id = a.id
        WHERE s.transaction_id = ? AND (a.name = ? OR a.name = ?)
      `;
      const split = ledger.db.prepare(splitSql).get(
        params.transactionId,
        'Expenses:Uncategorized',
        'Income:Uncategorized'
      ) as any;

      if (!split) {
        throw new Error(`Transaction ${params.transactionId} has no Uncategorized split`);
      }

      // Suggest based on learned rules
      const rules = loadRules();
      const payee = transaction.description || '';
      const memo = split.memo || '';
      const suggestion = suggestCategory(payee, memo, rules);

      if (!suggestion.matched) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No learned rule matches transaction ${params.transactionId} ` +
                `("${payee}"). You must reason over the transaction details and call ` +
                `\`apply_category\` with your chosen account.`,
            },
          ],
          details: { matched: false, transactionId: params.transactionId },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Suggested category for TX ${params.transactionId}: ${suggestion.accountName} ` +
              `(confidence: ${suggestion.confidence}). ${suggestion.explanation}`,
          },
        ],
        details: {
          matched: true,
          transactionId: params.transactionId,
          accountName: suggestion.accountName,
          confidence: suggestion.confidence,
          explanation: suggestion.explanation,
        },
      };
    },
  });

  // Tool: apply_category
  pi.registerTool({
    name: 'apply_category',
    label: 'Apply Category',
    description:
      'Categorize a single transaction or bulk-categorize matching transactions. ' +
      'Moves the split from Expenses:Uncategorized/Income:Uncategorized to a real category account. ' +
      'Updates the vendor rules if the payee is not yet learned.',
    parameters: Type.Object({
      transactionId: Type.Optional(
        Type.Number({
          description: 'Single transaction ID to categorize (omit if using filter for bulk)',
        })
      ),
      filter: Type.Optional(
        Type.Object({
          payeeContains: Type.Optional(
            Type.String({
              description:
                'Bulk filter: substring match (case-insensitive) on transaction description',
            })
          ),
          maxAmountMinor: Type.Optional(
            Type.Number({
              description:
                'Bulk filter: only apply to splits with abs(amount) <= maxAmountMinor (in cents)',
            })
          ),
          kind: Type.Optional(
            Type.Enum(['expense', 'income'], {
              description: 'Bulk filter: transaction kind',
            })
          ),
        })
      ),
      accountName: Type.String({
        description:
          'Target account name (colon-path, e.g. "Expenses:Office Supplies" or "Income:Freelance"). ' +
          'Auto-created if it does not exist.',
      }),
      force: Type.Optional(
        Type.Boolean({
          description: 'Not used; present for consistency with other tools.',
        })
      ),
    }),
    promptSnippet: '`apply_category` — categorize a single or bulk transaction(s)',
    promptGuidelines: [
      'Confirm the target account (colon-path, e.g. "Expenses:Office Supplies") with the user.',
      'For single categorization: pass transactionId.',
      'For bulk categorization: pass filter (payeeContains, maxAmountMinor, and/or kind) and accountName.',
      'The target account is auto-created if it does not exist.',
      'The payee is automatically learned and will suggest this account for future matching transactions.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      if (params.transactionId !== undefined && params.filter !== undefined) {
        throw new Error('Cannot specify both transactionId and filter; use one or the other');
      }

      if (params.transactionId === undefined && params.filter === undefined) {
        throw new Error('Must specify either transactionId or filter');
      }

      if (params.transactionId !== undefined) {
        // Single transaction
        const result = applyCategory(ledger, params.transactionId, params.accountName);
        return {
          content: [
            {
              type: 'text',
              text:
                `Categorized transaction ${result.transactionId} to ${result.newAccountName}. ` +
                (result.ruleRecorded ? 'Rule recorded for future matching.' : ''),
            },
          ],
          details: result,
        };
      } else {
        // Bulk categorization
        const result = bulkRecategorize(ledger, params.filter!, params.accountName);
        const failedText =
          result.failed.length > 0
            ? ` ${result.failed.length} failed: ` +
              result.failed.map((f) => `TX ${f.transactionId} (${f.error})`).join(', ')
            : '';
        return {
          content: [
            {
              type: 'text',
              text: `Bulk-categorized ${result.updated} transaction(s) to ${params.accountName}.${failedText}`,
            },
          ],
          details: result,
        };
      }
    },
  });
}
