/**
 * Pi extension: bank_sync ingestion tools.
 * Registers two tools: log_transaction, import_csv.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as bookkeeping/index.ts, same BOOKKEEPING_DB_PATH/:memory:
 * resolution) — a second connection to the same SQLite file, safe under
 * WAL mode (see EXTENSION.md "Risks and gotchas").
 */

import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { toMinor } from '../bookkeeping/money.ts';
import { postIngestedEntry } from './ingestion.ts';
import { parseCsvText, detectColumns, parseDate, parseAmountCents, type ColumnOverrides } from './csv.ts';

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

  // Tool: log_transaction
  pi.registerTool({
    name: 'log_transaction',
    label: 'Log Transaction',
    description:
      'Post a single confirmed transaction (manual entry) as a balanced double-entry ' +
      'against an Uncategorized account.',
    parameters: Type.Object({
      date: Type.String({ description: 'Transaction date (YYYY-MM-DD)' }),
      amount: Type.Number({
        description:
          'Amount in major units (dollars), signed: negative = money out (expense), ' +
          'positive = money in (income/deposit). Same convention as post_transaction.',
      }),
      account: Type.String({
        description: 'Source account (e.g. "Assets:Checking")',
      }),
      payee: Type.String({
        description: 'Payee/description text (stored as the transaction description).',
      }),
      memo: Type.Optional(Type.String({ description: 'Optional split memo' })),
      force: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to post even if a likely duplicate is found. Default: false.',
        })
      ),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to approve posting if the transaction exceeds the auto-post limit. Default: false.',
        })
      ),
    }),
    promptSnippet: '`log_transaction` — post a single confirmed conversational entry',
    promptGuidelines: [
      'Confirm the parsed date, amount, payee, and account with the user before calling this tool.',
      'Amount sign matches post_transaction: negative = expense (money out), positive = income (money in).',
      'The offsetting account is inferred automatically: Expenses:Uncategorized for expenses, ' +
        'Income:Uncategorized for income. Do not pass a separate offsetting account.',
      'Likely duplicates are blocked, not silently posted. If blocked, tell the user which existing ' +
        'transaction matched and re-call with force: true only if the user confirms it is not a duplicate.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');
      try {
        const amountMinor = toMinor(params.amount);
        const result = postIngestedEntry(ledger, {
          date: params.date,
          amountMinor,
          account: params.account,
          description: params.payee,
          memo: params.memo,
          force: params.force ?? false,
          approved: params.approved ?? false,
        });

        if ('duplicate' in result) {
          const dup = result.duplicate;
          throw new Error(
            `Likely duplicate of existing transaction ${dup.transactionId} (${dup.date}, ` +
              `${dup.description ?? '(no description)'}). Re-call with force: true if the user ` +
              `confirms this is not a duplicate.`
          );
        }

        const text = `Logged transaction ${result.transactionId} on ${params.date}: ${params.payee}`;
        return {
          content: [{ type: 'text', text }],
          details: { transactionId: result.transactionId, splitIds: result.splitIds },
        };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });

  // Tool: import_csv
  pi.registerTool({
    name: 'import_csv',
    label: 'Import CSV',
    description:
      'Bulk-import a bank/card CSV export, posting every valid row as an uncategorized entry.',
    parameters: Type.Object({
      path: Type.String({
        description: 'Path to the CSV file, resolved from cwd (e.g. "data/inbox/chase_march.csv")',
      }),
      account: Type.String({
        description: 'Source account for every row (e.g. "Assets:Checking")',
      }),
      date_column: Type.Optional(Type.String({ description: 'Column header override for date' })),
      amount_column: Type.Optional(Type.String({ description: 'Column header override for signed amount' })),
      debit_column: Type.Optional(Type.String({ description: 'Column header override for debit' })),
      credit_column: Type.Optional(Type.String({ description: 'Column header override for credit' })),
      description_column: Type.Optional(
        Type.String({ description: 'Column header override for description/payee' })
      ),
      date_window_days: Type.Optional(
        Type.Number({ description: 'Dedup date window in days. Default: 3.' })
      ),
      force_duplicates: Type.Optional(
        Type.Boolean({ description: 'Post likely-duplicate rows instead of skipping them. Default: false.' })
      ),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to approve posting for rows exceeding the auto-post limit (applies to the whole import). Default: false.',
        })
      ),
    }),
    promptSnippet: '`import_csv` — bulk-import a bank/card CSV export',
    promptGuidelines: [
      'Columns are auto-detected (date, amount or debit/credit, description/payee); pass the ' +
        '*_column overrides only if auto-detection fails.',
      'Every valid row posts as an uncategorized entry (Expenses:Uncategorized / Income:Uncategorized).',
      'Likely-duplicate rows are skipped by default and reported in skipped_duplicates with the ' +
        'matched transaction id — never silently dropped. Use force_duplicates: true to re-post them.',
      'Malformed rows (bad date, non-numeric amount, unknown account, threshold-blocked) are reported ' +
        'in errors with the row number; the rest of the file still imports.',
      'This tool only throws for whole-file problems (file not found, no recognizable columns).',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      let text: string;
      try {
        text = readFileSync(params.path, 'utf-8');
      } catch (err: any) {
        throw new Error(`Could not read CSV file at '${params.path}': ${err.message}`);
      }

      const { header, rows } = parseCsvText(text);

      const overrides: ColumnOverrides = {
        date_column: params.date_column,
        amount_column: params.amount_column,
        debit_column: params.debit_column,
        credit_column: params.credit_column,
        description_column: params.description_column,
      };

      // detectColumns throws for whole-file problems (no recognizable columns).
      const cols = detectColumns(header, overrides);

      const imported: Array<{ row: number; transactionId: number }> = [];
      const skipped_duplicates: Array<{ row: number; transactionId: number; date: string; description: string | null }> = [];
      const errors: Array<{ row: number; reason: string }> = [];

      rows.forEach((row, idx) => {
        const rowNum = idx + 2; // account for header row + 1-indexing

        let date: string;
        let amountMinor: number;
        try {
          date = parseDate(row[cols.dateCol] ?? '');
          amountMinor = parseAmountCents(row, cols);
        } catch (err: any) {
          errors.push({ row: rowNum, reason: err.message });
          return;
        }

        const description = (row[cols.descriptionCol] ?? '').trim() || null;

        try {
          const result = postIngestedEntry(ledger!, {
            date,
            amountMinor,
            account: params.account,
            description,
            force: params.force_duplicates ?? false,
            approved: params.approved ?? false,
            windowDays: params.date_window_days,
          });

          if ('duplicate' in result) {
            const dup = result.duplicate;
            skipped_duplicates.push({
              row: rowNum,
              transactionId: dup.transactionId,
              date: dup.date,
              description: dup.description,
            });
          } else {
            imported.push({ row: rowNum, transactionId: result.transactionId });
          }
        } catch (err: any) {
          errors.push({ row: rowNum, reason: err.message });
        }
      });

      const text_summary =
        `Imported ${imported.length} row(s), skipped ${skipped_duplicates.length} likely duplicate(s), ` +
        `${errors.length} error(s) out of ${rows.length} row(s).`;

      return {
        content: [{ type: 'text', text: text_summary }],
        details: { imported, skipped_duplicates, errors },
      };
    },
  });
}
