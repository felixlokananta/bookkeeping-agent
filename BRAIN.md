# Domain Knowledge: Chart of Accounts and Ledger Model

## Account Types and Normal Balances

The ledger is organized into five account types, each with a normal (expected) balance direction:

| Type | Normal Balance | Example |
|------|---|---|
| **Asset** | Debit | Cash, Checking, Accounts Receivable |
| **Liability** | Credit | Credit Card, Accounts Payable, Loans |
| **Equity** | Credit | Owner's Capital, Retained Earnings |
| **Income** | Credit | Revenue, Sales, Investment Income |
| **Expense** | Debit | Salary, Rent, Supplies, Food |

**Double-entry principle:** Every transaction posts at least two splits (debit and credit) to different accounts, such that debits always equal credits.

## Chart of Accounts Structure

The default chart has five root accounts (one per type):

- `Assets` (type: asset)
- `Liabilities` (type: liability)
- `Equity` (type: equity)
- `Income` (type: income)
- `Expenses` (type: expense)

Sub-accounts are created using colon-path notation: `Assets:Checking`, `Expenses:Food:Groceries`, etc. Parent accounts are auto-created if missing.

## Currency and Precision

- **Base currency:** USD (configurable in `config/settings.yaml`)
- **Precision:** 2 decimal places (cents); all monetary amounts are stored as integer minor units (cents) internally.
- **Fiscal year:** Calendar year (January–December; refinable in future issues)

## Key Concepts

- **Normal balance:** The direction (debit or credit) that increases an account. E.g., Assets increase with debits, Liabilities with credits.
- **Natural balance:** The balance shown to a user, always positive when the account is "full" (e.g., a $100 checking account shows +100, not -100). The raw database sum is adjusted by the normal balance direction.
- **Balanced transaction:** A transaction where total debits == total credits (always sums to zero in the database).

## Future Considerations (Out of Scope, Issue #1)

- Vendor rules and categorization learning (issue #4)
- Tax rules and category mappings (issue #5)
- Multi-currency and foreign-exchange handling
- Recurring transactions and period-end closings
