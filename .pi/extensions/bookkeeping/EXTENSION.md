# Bookkeeping Extension

**Status:** Functional (Issue #1)

This extension provides a complete double-entry ledger backed by SQLite, enforcing the double-entry principle and exposing five core tools for ledger operations.

## Overview

The bookkeeping extension maintains a persistent, balanced ledger with:
- A chart of accounts (Assets, Liabilities, Equity, Income, Expenses)
- Nested sub-account support using colon-path notation (e.g., `Assets:Checking`, `Expenses:Food:Groceries`)
- Balanced transaction posting (debits == credits)
- Automatic enforcement of the auto-post approval threshold
- Append-only transaction history (no editing/deleting in v1)

## Tools

### `list_accounts`
Display all accounts in the chart of accounts, with types and normal balances.
- **Params:** None
- **Returns:** Chart of accounts

### `create_account`
Create a new account or sub-account.
- **Params:**
  - `name` (string, required): Colon-path account name (e.g., `Assets:Checking`, `Expenses:Food:Groceries`)
  - `type` (enum, optional): Account type (asset, liability, equity, income, expense). Optional if parent exists.
- **Returns:** Created account details

### `post_transaction`
Post a balanced journal entry to the ledger.
- **Params:**
  - `date` (string, required): Transaction date (YYYY-MM-DD)
  - `description` (string, optional): Transaction description
  - `approved` (boolean, optional, default: false): Set to true to override the auto-post limit
  - `splits` (array, required): At least 2 splits:
    - `account` (string): Account name
    - `amount` (number): Amount in major units (dollars). Positive = debit, negative = credit.
    - `memo` (string, optional): Split memo
- **Returns:** Transaction ID and split IDs
- **Validations:**
  - At least 2 splits
  - All amounts are non-zero integers
  - Splits sum to zero (balanced)
  - All accounts must exist
  - Total debits must not exceed the auto-post limit (default $500) unless `approved: true`
- **Behavior:** If validation fails, the transaction is rejected and logged to `memory/anomaly_log.json`.

### `get_balance`
Query the balance of an account as of a given date.
- **Params:**
  - `account` (string, required): Account name
  - `asOf` (string, optional): Date (YYYY-MM-DD) to get balance as of that date
  - `includeChildren` (boolean, optional, default: false): Include balances of child accounts
- **Returns:** Natural balance (formatted), raw balance, and account details

### `list_transactions`
List transactions with optional filters.
- **Params:**
  - `account` (string, optional): Filter by account name
  - `start_date` (string, optional): Start date (YYYY-MM-DD)
  - `end_date` (string, optional): End date (YYYY-MM-DD)
  - `limit` (number, optional, default: 100): Maximum number of transactions to return
- **Returns:** List of transactions with their splits

## Hard Rules (Code-Enforced)

1. **Auto-post threshold:** Transactions whose total debits exceed the `auto_post_limit` in `config/policies.yaml` (default $500) are blocked unless explicitly approved via `approved: true`. Blocked transactions are logged to `memory/anomaly_log.json`.

2. **Double-entry invariant:** Every transaction's splits must sum to zero. Unbalanced posts are rejected and logged.

3. **Append-only ledger:** Transactions cannot be edited or deleted in v1. Corrections require reversing entries.

## Configuration

- **Auto-post limit:** Set in `config/policies.yaml` (env override: `BOOKKEEPING_AUTOPOST_LIMIT` in major units)
- **Database path:** Defaults to `data/bookkeeping.db` (env override: `BOOKKEEPING_DB_PATH`)

## Implementation Details

- **Language:** TypeScript (Node.js native modules via pi's jiti loader)
- **Database:** SQLite via Node 24's `node:sqlite` (DatabaseSync)
- **Money:** Integer minor units (cents); floats only at tool boundaries
- **Anomaly logging:** Append-only JSON file at `memory/anomaly_log.json`

## Future Issues

- Issue #2: Bank synchronization and statement import
- Issue #3: Receipt/invoice OCR
- Issue #4: Automatic categorization with vendor rules
- Issue #5: Reporting and tax export
