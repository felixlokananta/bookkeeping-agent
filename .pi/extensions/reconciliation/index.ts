/**
 * Pi extension: reconciliation tools.
 * Registers two tools: reconcile_account, verify_ledger.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as other extensions).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { toMinor, toMajor, formatMoney } from '../bookkeeping/money.ts';
import {
  reconcileAccount,
  diffStatementBalance,
  matchStatementToLedger,
  listUnreconciledSplits,
  type StatementRow,
  type ColumnOverrides,
} from './reconcile.ts';
import { verifyLedger } from './verify.ts';

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

  // Tool: reconcile_account
  pi.registerTool({
    name: 'reconcile_account',
    label: 'Reconcile Account',
    description:
      'Reconcile a ledger account against a bank statement (balance-only or CSV). ' +
      'Matches statement lines to ledger splits using tiered matching (exact amount + date window, ' +
      'then fuzzy description fallback), computes balance discrepancy, and optionally marks matched entries as reconciled.',
    parameters: Type.Object({
      account: Type.String({
        description: 'Account name to reconcile (e.g. "Assets:Checking")',
      }),
      periodStart: Type.String({
        description: 'Period start date (YYYY-MM-DD)',
      }),
      periodEnd: Type.String({
        description: 'Period end date (YYYY-MM-DD)',
      }),
      statementBalance: Type.Number({
        description: 'Statement balance in major units (dollars)',
      }),
      statementPath: Type.Optional(
        Type.String({
          description: 'Path to statement CSV file (auto-detects columns; pass overrides if needed)',
        })
      ),
      date_column: Type.Optional(Type.String({ description: 'Column header override for date' })),
      amount_column: Type.Optional(Type.String({ description: 'Column header override for signed amount' })),
      debit_column: Type.Optional(Type.String({ description: 'Column header override for debit' })),
      credit_column: Type.Optional(Type.String({ description: 'Column header override for credit' })),
      description_column: Type.Optional(
        Type.String({ description: 'Column header override for description/payee' })
      ),
      memo_column: Type.Optional(Type.String({ description: 'Column header override for memo/notes' })),
      windowDays: Type.Optional(
        Type.Number({
          description: 'Date window in days for Tier 1 matching (exact amount + date). Default: 3.',
        })
      ),
      markReconciled: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to mark matched entries as reconciled and persist the reconciliation run. ' +
            'Default: false (preview mode).',
        })
      ),
    }),
    promptSnippet: '`reconcile_account` — reconcile a ledger account against a statement',
    promptGuidelines: [
      'Call without markReconciled first to preview matches and discrepancies.',
      'Statement CSV columns are auto-detected (date, amount/debit/credit, description); ' +
        'pass the *_column overrides only if auto-detection fails.',
      'Matching uses tiered logic: Tier 1 matches exact amount + date within windowDays; ' +
        'Tier 2 (fallback) matches exact amount + fuzzy description regardless of date.',
      'A matched transaction with a non-null source_path (from receipt capture) is flagged sourcedFromReceipt: true.',
      'Once the user confirms the matches and discrepancy, re-call with markReconciled: true to persist.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const statementBalanceMinor = toMinor(params.statementBalance);

      const columnOverrides: ColumnOverrides = {
        date_column: params.date_column,
        amount_column: params.amount_column,
        debit_column: params.debit_column,
        credit_column: params.credit_column,
        description_column: params.description_column,
        memo_column: params.memo_column,
      };

      const result = reconcileAccount(ledger, {
        account: params.account,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        statementBalanceMinor,
        statementPath: params.statementPath,
        columnOverrides: Object.values(columnOverrides).some((v) => v !== undefined)
          ? columnOverrides
          : undefined,
        windowDays: params.windowDays ?? 3,
        markReconciled: params.markReconciled ?? false,
      });

      // Format output text
      const diffMinor = result.diff.discrepancyMinor;
      const diffMajor = toMajor(diffMinor);
      const discrepancySign = diffMinor === 0 ? 'none' : diffMinor > 0 ? 'ledger high' : 'statement high';

      const text = `Reconciliation for ${params.account} (${params.periodStart} to ${params.periodEnd}):
Ledger balance: ${formatMoney(result.diff.ledgerNaturalMinor)}
Statement balance: ${formatMoney(result.diff.statementBalanceMinor)}
Discrepancy: ${formatMoney(diffMinor)} (${discrepancySign})

Matches: ${result.matches.matched.length} entries
Ledger-only: ${result.matches.ledgerOnly.length} entries
Statement-only: ${result.matches.statementOnly.length} entries

${params.markReconciled ? `Reconciliation run #${result.runId} created and ${result.matches.matched.length} split(s) marked as reconciled.` : 'Preview mode (no entries marked). Re-call with markReconciled: true to persist.'}`;

      return {
        content: [{ type: 'text', text }],
        details: {
          diff: {
            ledgerNaturalMinor: result.diff.ledgerNaturalMinor,
            statementBalanceMinor: result.diff.statementBalanceMinor,
            discrepancyMinor: result.diff.discrepancyMinor,
          },
          matches: {
            matched: result.matches.matched.map((m) => ({
              statementRow: m.statementRow,
              splitId: m.splitId,
              transactionId: m.transactionId,
              sourcedFromReceipt: m.sourcedFromReceipt,
              receiptPath: m.receiptPath,
            })),
            ledgerOnly: result.matches.ledgerOnly,
            statementOnly: result.matches.statementOnly,
          },
          runId: result.runId,
        },
      };
    },
  });

  // Tool: verify_ledger
  pi.registerTool({
    name: 'verify_ledger',
    label: 'Verify Ledger Integrity',
    description:
      'Run period-end integrity checks on the ledger: detect unbalanced transactions, ' +
      'orphan splits (referencing non-existent transactions/accounts), verify trial balance, ' +
      'and flag accounts with unexpected-sign balances.',
    parameters: Type.Object({
      asOf: Type.Optional(
        Type.String({
          description: 'Optional date cutoff (YYYY-MM-DD); if omitted, checks entire ledger',
        })
      ),
    }),
    promptSnippet: '`verify_ledger` — run integrity checks on the ledger',
    promptGuidelines: [
      'Use this at period end to detect data integrity issues.',
      'Returns unbalanced transactions, orphan splits, trial balance, and accounts with unexpected-sign balances.',
      'Pass asOf to check integrity up to a specific date; omit to check the entire ledger.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      const verification = verifyLedger(ledger, { asOf: params.asOf });

      const statusText = verification.trialBalanceOk
        ? 'Trial balance OK (sum of all splits is zero)'
        : `Trial balance FAILED: ${formatMoney(verification.trialBalanceMinor)}`;

      let text = `Ledger verification ${params.asOf ? `(as of ${params.asOf})` : '(entire ledger)'}:\n\n${statusText}`;

      if (verification.unbalancedTransactions.length > 0) {
        text += `\n\nUnbalanced transactions: ${verification.unbalancedTransactions.length}`;
        for (const tx of verification.unbalancedTransactions.slice(0, 5)) {
          text += `\n  - Tx #${tx.transactionId} (${tx.date}): ${tx.description || '(no desc)'} — sum=${formatMoney(tx.sumAmount)}`;
        }
        if (verification.unbalancedTransactions.length > 5) {
          text += `\n  ... and ${verification.unbalancedTransactions.length - 5} more`;
        }
      }

      if (verification.orphanSplits.length > 0) {
        text += `\n\nOrphan splits: ${verification.orphanSplits.length}`;
      }

      if (verification.unexpectedSignAccounts.length > 0) {
        text += `\n\nAccounts with unexpected-sign balances: ${verification.unexpectedSignAccounts.length}`;
        for (const acc of verification.unexpectedSignAccounts.slice(0, 5)) {
          text += `\n  - ${acc.accountName}: ${acc.signMismatch}`;
        }
        if (verification.unexpectedSignAccounts.length > 5) {
          text += `\n  ... and ${verification.unexpectedSignAccounts.length - 5} more`;
        }
      }

      return {
        content: [{ type: 'text', text }],
        details: verification,
      };
    },
  });
}
