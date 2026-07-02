/**
 * Pi extension: reporting tools.
 * Registers four tools: spending_by_category, income_statement, balance_sheet, tax_year_export.
 *
 * Opens its own ledger handle per session (same openLedger/closeLedger
 * pattern as categorization, same BOOKKEEPING_DB_PATH/:memory: resolution).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openLedger, closeLedger, type Ledger } from '../bookkeeping/ledger.ts';
import { formatMoney, toMajor } from '../bookkeeping/money.ts';
import {
  spendingByCategory,
  incomeStatement,
  balanceSheet,
  taxYearExport,
  type SpendingCategory,
  type IncomeStatementResult,
  type BalanceSheetResult,
  type TaxYearRow,
} from './reports.ts';
import { toCsv } from './csv.ts';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';

let ledger: Ledger | null = null;

interface SpendingByCategoryDetails {
  categories: SpendingCategory[];
}

interface IncomeStatementDetails extends IncomeStatementResult {}

interface BalanceSheetDetails extends BalanceSheetResult {}

interface TaxYearExportDetails {
  filePath: string;
  rowCount: number;
}

/**
 * Resolve a user-supplied outputPath/fileName inside data/exports/, rejecting
 * any path that would escape that directory (e.g. via `..` segments or an
 * absolute path elsewhere).
 */
export function resolveExportPath(fileName: string | undefined, defaultName: string): string {
  const exportsDir = resolve(process.cwd(), 'data/exports');
  const outputPath = resolve(exportsDir, fileName || defaultName);
  if (outputPath !== exportsDir && !outputPath.startsWith(exportsDir + sep)) {
    throw new Error(`Invalid outputPath: must resolve inside data/exports/ (got '${fileName}')`);
  }
  return outputPath;
}

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

  // Tool: spending_by_category
  pi.registerTool({
    name: 'spending_by_category',
    label: 'Spending by Category',
    description:
      'Get a spending breakdown by expense category (or custom root account) over a date range. ' +
      'Returns hierarchical tree with parent and child account totals.',
    parameters: Type.Object({
      startDate: Type.String({
        description: 'Start date (YYYY-MM-DD)',
      }),
      endDate: Type.String({
        description: 'End date (YYYY-MM-DD)',
      }),
      rootAccount: Type.Optional(
        Type.String({
          description: 'Root account to drill into (default: Expenses)',
        })
      ),
    }),
    promptSnippet: '`spending_by_category` — show spending breakdown by category',
    promptGuidelines: [
      'Use this to see how much was spent on each category (e.g., Food, Entertainment, etc.) over a period.',
      'The response shows a hierarchical breakdown with parent and child accounts.',
      'You can pass a specific root account (e.g., "Expenses:Food") to drill into a category.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      try {
        const categories = spendingByCategory(ledger, {
          startDate: params.startDate,
          endDate: params.endDate,
          rootAccount: params.rootAccount,
        });

        const text = formatSpendingTree(categories);

        return {
          content: [{ type: 'text', text }],
          details: { categories } as SpendingByCategoryDetails,
        };
      } catch (err) {
        throw err;
      }
    },
  });

  // Tool: income_statement
  pi.registerTool({
    name: 'income_statement',
    label: 'Income Statement (P&L)',
    description:
      'Generate an income statement (profit & loss) for a date range. ' +
      'Shows income, expenses, and net income.',
    parameters: Type.Object({
      startDate: Type.String({
        description: 'Start date (YYYY-MM-DD)',
      }),
      endDate: Type.String({
        description: 'End date (YYYY-MM-DD)',
      }),
    }),
    promptSnippet: '`income_statement` — show P&L for a period',
    promptGuidelines: [
      'Use this to see total income, expenses, and net profit/loss for a period.',
      'The response includes a breakdown by account.',
      'Income is positive, expenses are positive, net income is income minus expenses.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      try {
        const result = incomeStatement(ledger, {
          startDate: params.startDate,
          endDate: params.endDate,
        });

        const text = formatIncomeStatement(result);

        return {
          content: [{ type: 'text', text }],
          details: result as IncomeStatementDetails,
        };
      } catch (err) {
        throw err;
      }
    },
  });

  // Tool: balance_sheet
  pi.registerTool({
    name: 'balance_sheet',
    label: 'Balance Sheet',
    description:
      'Generate a balance sheet as of a given date. ' +
      'Shows assets, liabilities, equity, and verifies the accounting identity (Assets = Liabilities + Equity).',
    parameters: Type.Object({
      asOf: Type.String({
        description: 'Balance sheet date (YYYY-MM-DD)',
      }),
    }),
    promptSnippet: '`balance_sheet` — show balance sheet as of a date',
    promptGuidelines: [
      'Use this to see the financial position (assets, liabilities, equity) as of a specific date.',
      'The response includes retained earnings (cumulative net income), and verifies that Assets = Liabilities + Equity.',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      try {
        const result = balanceSheet(ledger, {
          asOf: params.asOf,
        });

        const text = formatBalanceSheet(result);

        return {
          content: [{ type: 'text', text }],
          details: result as BalanceSheetDetails,
        };
      } catch (err) {
        throw err;
      }
    },
  });

  // Tool: tax_year_export
  pi.registerTool({
    name: 'tax_year_export',
    label: 'Tax Year Export',
    description:
      'Export income and expense transactions for a tax year as a CSV file. ' +
      'Each row is a split with date, category, description, and amount.',
    parameters: Type.Object({
      year: Type.Number({
        description: 'Tax year (e.g., 2025)',
      }),
      outputPath: Type.Optional(
        Type.String({
          description:
            'Output file name/relative path, resolved inside data/exports/ ' +
            '(default: tax-export-<year>.csv). Paths escaping data/exports/ are rejected.',
        })
      ),
    }),
    promptSnippet: '`tax_year_export` — export tax data for a year as CSV',
    promptGuidelines: [
      'Use this to export all income and expense transactions for a tax year to a CSV file.',
      'The output includes date, category (account name), description, and amount.',
      'The file is saved to the output path (or a default data/exports/ location).',
    ],
    execute: async (_toolCallId, params) => {
      if (!ledger) throw new Error('Ledger not initialized');

      try {
        const rows = taxYearExport(ledger, {
          year: params.year,
        });

        // Convert to CSV format
        const columns: (keyof TaxYearRow & string)[] = [
          'date',
          'accountName',
          'description',
          'amountMajor',
        ];
        const csv = toCsv(rows, columns);

        // Determine output path, constrained to the data/exports/ directory
        const outputPath = resolveExportPath(
          params.outputPath,
          `tax-export-${params.year}.csv`
        );

        // Ensure directory exists
        const dirPath = dirname(outputPath);
        mkdirSync(dirPath, { recursive: true });

        // Write to file
        writeFileSync(outputPath, csv, 'utf-8');

        const text = `Exported ${rows.length} transaction(s) for tax year ${params.year} to ${outputPath}`;

        return {
          content: [{ type: 'text', text }],
          details: {
            filePath: outputPath,
            rowCount: rows.length,
          } as TaxYearExportDetails,
        };
      } catch (err) {
        throw err;
      }
    },
  });
}

/**
 * Format spending categories as a readable string.
 */
function formatSpendingTree(categories: SpendingCategory[], depth = 0): string {
  let text = '';
  const indent = '  '.repeat(depth);

  for (const cat of categories) {
    text += `${indent}${cat.accountName}: $${formatMoney(cat.totalMinor)}\n`;
    if (cat.children.length > 0) {
      text += formatSpendingTree(cat.children, depth + 1);
    }
  }

  return text;
}

/**
 * Format income statement as a readable string.
 */
function formatIncomeStatement(result: IncomeStatementResult): string {
  let text = 'Income Statement\n';
  text += '==================\n\n';

  text += 'Income:\n';
  for (const item of result.incomeByAccount) {
    text += `  ${item.accountName}: $${formatMoney(item.totalMinor)}\n`;
  }
  text += `Total Income: $${formatMoney(result.incomeMinor)}\n\n`;

  text += 'Expenses:\n';
  for (const item of result.expenseByAccount) {
    text += `  ${item.accountName}: $${formatMoney(item.totalMinor)}\n`;
  }
  text += `Total Expenses: $${formatMoney(result.expenseMinor)}\n\n`;

  text += `Net Income: $${formatMoney(result.netIncomeMinor)}\n`;

  return text;
}

/**
 * Format balance sheet as a readable string.
 */
export function formatBalanceSheet(result: BalanceSheetResult): string {
  let text = 'Balance Sheet\n';
  text += '==================\n\n';

  text += 'Assets:\n';
  for (const item of result.assets) {
    text += `  ${item.accountName}: $${formatMoney(item.totalMinor)}\n`;
  }
  text += `Total Assets: $${formatMoney(result.totalAssetsMinor)}\n\n`;

  text += 'Liabilities:\n';
  for (const item of result.liabilities) {
    text += `  ${item.accountName}: $${formatMoney(item.totalMinor)}\n`;
  }
  text += `Total Liabilities: $${formatMoney(result.totalLiabilitiesMinor)}\n\n`;

  text += 'Equity:\n';
  for (const item of result.equityAccounts) {
    text += `  ${item.accountName}: $${formatMoney(item.totalMinor)}\n`;
  }
  text += `Total Equity: $${formatMoney(result.totalEquityMinor)}\n\n`;

  text += `Total Liabilities + Equity: $${formatMoney(result.totalLiabilitiesAndEquityMinor)}\n\n`;

  // Verify accounting identity
  if (result.totalAssetsMinor === result.totalLiabilitiesAndEquityMinor) {
    text += '✓ Accounting identity verified: Assets = Liabilities + Equity\n';
  } else {
    text += `⚠ Accounting identity mismatch: Assets ($${formatMoney(result.totalAssetsMinor)}) ≠ Liabilities + Equity ($${formatMoney(result.totalLiabilitiesAndEquityMinor)})\n`;
  }

  return text;
}
