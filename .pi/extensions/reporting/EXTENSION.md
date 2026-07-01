# Reporting Extension

**Status:** Active (Issue #5 — Reporting and tax export)

This extension provides four reporting and export tools for financial analysis and tax compliance.

## Tools

### `spending_by_category`
Hierarchical spending breakdown by expense category (or custom account root) over a date range.
- **Parameters:** `startDate`, `endDate`, `rootAccount` (optional, default: Expenses)
- **Returns:** Tree of categories with totals in natural balance

### `income_statement`
Profit & Loss statement for a date range.
- **Parameters:** `startDate`, `endDate`
- **Returns:** Total income, expenses, net income, plus breakdown by account

### `balance_sheet`
Balance sheet as of a given date, with retained earnings calculation to ensure Assets = Liabilities + Equity.
- **Parameters:** `asOf` (date)
- **Returns:** Assets, liabilities, equity (including retained earnings), totals, and accounting identity verification

### `tax_year_export`
CSV export of income and expense transactions for a tax year.
- **Parameters:** `year`, `outputPath` (optional, default: data/exports/tax-export-<year>.csv)
- **Returns:** File path and row count
