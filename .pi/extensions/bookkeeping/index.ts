/**
 * Pi extension: bookkeeping agent tools.
 * Registers five tools: list_accounts, create_account, post_transaction, get_balance, list_transactions.
 *
 * Opens the ledger once per session; converts major<->minor at boundaries.
 */

import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  openLedger,
  closeLedger,
  createAccount,
  postTransaction,
  getBalance,
  listAccounts,
  listTransactions,
  type Ledger,
} from './ledger.js';
import { toMinor, toMajor, formatMoney } from './money.js';
import { ACCOUNT_TYPES } from './schema.js';

let ledger: Ledger | null = null;

export default function (pi: ExtensionAPI) {
  // Session lifecycle
  pi.on('session_start', async () => {
    // Determine if we're running in-memory or file-backed
    const dbPath =
      process.env.BOOKKEEPING_DB_PATH || process.env.NODE_ENV === 'test'
        ? ':memory:'
        : undefined;
    ledger = openLedger(dbPath);
  });

  pi.on('session_shutdown', async () => {
    if (ledger) {
      closeLedger(ledger);
      ledger = null;
    }
  });

  // Tool: list_accounts
  pi.registerTool({
    name: 'list_accounts',
    description: 'List all accounts in the chart of accounts.',
    inputSchema: Type.Object({}),
    promptSnippet: '`list_accounts` — display the chart of accounts',
    promptGuidelines:
      'Show the full chart of accounts with types and normal balances. ' +
      'The ledger has five root accounts (Assets, Liabilities, Equity, Income, Expenses) ' +
      'and supports nested sub-accounts using colon notation (e.g., Assets:Checking).',
    execute: async () => {
      if (!ledger) throw new Error('Ledger not initialized');
      const accounts = listAccounts(ledger);
      const lines = accounts.map(
        (a) => `${a.name.padEnd(40)} | type: ${a.type.padEnd(10)} | normal: ${a.normal_balance}`
      );
      const text = 'Chart of Accounts:\n' + lines.join('\n');
      return { content: [{ type: 'text', text }], details: { accounts } };
    },
  });

  // Tool: create_account
  pi.registerTool({
    name: 'create_account',
    description: 'Create a new account or sub-account.',
    inputSchema: Type.Object({
      name: Type.String({
        description: 'Colon-path account name (e.g., "Assets:Checking" or "Expenses:Food:Groceries")',
      }),
      type: Type.Optional(
        Type.Enum(...ACCOUNT_TYPES, {
          description: 'Account type (asset, liability, equity, income, expense). Optional if parent exists.',
        })
      ),
    }),
    promptSnippet: '`create_account` — create a new account or sub-account',
    promptGuidelines:
      'Create accounts using colon-path notation. Parent accounts are auto-created if missing. ' +
      'Specifying a type is optional if the parent account exists (type is inherited). ' +
      'Every split must reference a known account name or creation will fail. ' +
      'Examples: "Assets:Checking", "Expenses:Food:Groceries", "Income:Salary".',
    execute: async (input: any) => {
      if (!ledger) throw new Error('Ledger not initialized');
      try {
        const account = createAccount(ledger, {
          name: input.name,
          type: input.type,
        });
        const text = `Created account: ${account.name} (${account.type}, normal: ${account.normal_balance})`;
        return { content: [{ type: 'text', text }], details: { account } };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });

  // Tool: post_transaction
  pi.registerTool({
    name: 'post_transaction',
    description: 'Post a balanced journal entry to the ledger.',
    inputSchema: Type.Object({
      date: Type.String({
        description: 'Transaction date (YYYY-MM-DD)',
      }),
      description: Type.Optional(Type.String({ description: 'Optional transaction description' })),
      approved: Type.Optional(
        Type.Boolean({
          description:
            'Set to true to approve posting if transaction exceeds the auto-post limit. Default: false.',
        })
      ),
      splits: Type.Array(
        Type.Object({
          account: Type.String({ description: 'Account name (e.g., "Assets:Checking")' }),
          amount: Type.Number({
            description: 'Amount in major units (dollars). Positive = debit, negative = credit.',
          }),
          memo: Type.Optional(Type.String({ description: 'Optional split memo' })),
        }),
        { description: 'Array of at least 2 splits (debits + credits)' }
      ),
    }),
    promptSnippet: '`post_transaction` — post a balanced journal entry',
    promptGuidelines:
      'Every transaction must have at least 2 splits and sum to zero (debits == credits). ' +
      'Amounts are in dollars (major units); positive amounts are debits, negative are credits. ' +
      'Example: debit Assets:Checking $100, credit Equity:Owner $100. ' +
      'If the total debits exceed the auto-post limit ($500 default), the post is blocked and requires approval. ' +
      'Unbalanced transactions are rejected and logged; never fabricate a balancing split. ' +
      'Surface imbalances, unknown accounts, and threshold blocks as errors to the user.',
    execute: async (input: any) => {
      if (!ledger) throw new Error('Ledger not initialized');
      try {
        const splits = input.splits.map((s: any) => ({
          account: s.account,
          amount: toMinor(s.amount),
          memo: s.memo,
        }));
        const result = postTransaction(ledger, {
          date: input.date,
          description: input.description,
          splits,
          approved: input.approved ?? false,
        });

        // Build a summary
        const txDetails = listTransactions(ledger, { limit: 1 })
          .reverse()
          .find((tx) => tx.id === result.transactionId);
        let summary = `Posted transaction ${result.transactionId} on ${input.date}`;
        if (input.description) {
          summary += `: ${input.description}`;
        }
        summary += '\nSplits:\n';
        if (txDetails?.splits) {
          summary += txDetails.splits
            .map(
              (s) =>
                `  ${s.account || `(account ${s.account_id})`} : ${formatMoney(s.amount)}`
            )
            .join('\n');
        }

        return {
          content: [{ type: 'text', text: summary }],
          details: { transactionId: result.transactionId, splitIds: result.splitIds },
        };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });

  // Tool: get_balance
  pi.registerTool({
    name: 'get_balance',
    description: 'Get the balance of an account.',
    inputSchema: Type.Object({
      account: Type.String({ description: 'Account name (e.g., "Assets:Checking")' }),
      asOf: Type.Optional(
        Type.String({ description: 'Optional date (YYYY-MM-DD) to get balance as of that date' })
      ),
      includeChildren: Type.Optional(
        Type.Boolean({
          description: 'Include balances of child accounts. Default: false.',
        })
      ),
    }),
    promptSnippet: '`get_balance` — query the balance of an account',
    promptGuidelines:
      'Returns the natural balance of an account (always shown positive when the account is "full"). ' +
      'For example, a $100 checking account shows $100 (not -$100). ' +
      'The natural balance is adjusted based on the account\'s normal-balance direction. ' +
      'Optionally filter by date (asOf) or include child account balances.',
    execute: async (input: any) => {
      if (!ledger) throw new Error('Ledger not initialized');
      try {
        const balance = getBalance(ledger, {
          account: input.account,
          asOf: input.asOf,
          includeChildren: input.includeChildren ?? false,
        });
        const text = `${balance.name}: ${formatMoney(balance.naturalMinor)}`;
        return {
          content: [{ type: 'text', text }],
          details: balance,
        };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });

  // Tool: list_transactions
  pi.registerTool({
    name: 'list_transactions',
    description: 'List transactions with optional filters.',
    inputSchema: Type.Object({
      account: Type.Optional(Type.String({ description: 'Filter by account name' })),
      start_date: Type.Optional(Type.String({ description: 'Start date (YYYY-MM-DD)' })),
      end_date: Type.Optional(Type.String({ description: 'End date (YYYY-MM-DD)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of transactions to return. Default: 100.' })),
    }),
    promptSnippet: '`list_transactions` — query transaction history',
    promptGuidelines:
      'List transactions in date order, optionally filtered by account and date range. ' +
      'Each transaction shows its date, description, and all splits (debits and credits). ' +
      'Use this to verify posts and review transaction history.',
    execute: async (input: any) => {
      if (!ledger) throw new Error('Ledger not initialized');
      try {
        const transactions = listTransactions(ledger, {
          account: input.account,
          startDate: input.start_date,
          endDate: input.end_date,
          limit: input.limit ?? 100,
        });

        if (transactions.length === 0) {
          return {
            content: [{ type: 'text', text: 'No transactions found.' }],
            details: { transactions: [] },
          };
        }

        const lines: string[] = [];
        for (const tx of transactions) {
          lines.push(`${tx.id} | ${tx.date} | ${tx.description || '(no description)'}`);
          for (const split of tx.splits) {
            const account = listAccounts(ledger).find((a) => a.id === split.account_id);
            const accountName = account?.name || `(account ${split.account_id})`;
            const amountStr = formatMoney(split.amount);
            lines.push(`  - ${accountName}: ${amountStr}`);
          }
        }
        const text = lines.join('\n');

        return {
          content: [{ type: 'text', text }],
          details: { transactions },
        };
      } catch (err: any) {
        throw new Error(err.message);
      }
    },
  });
}
