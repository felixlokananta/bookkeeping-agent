# Talking to the Bookkeeping Agent

This is a plain-language guide to interacting with the agent in everyday use, organized by
scenario rather than by tool. For the underlying rules the agent follows, see `AGENTS.md`; for the
domain model (chart of accounts, currency, etc.), see `BRAIN.md`; for full tool reference and
architecture, see `README.md`.

Start a session with:
```bash
npm run agent
```

Everything below is a chat message you'd type at the prompt, followed by roughly what happens.

## 1. Everyday spending — just tell it what happened

You don't need to know account names or double-entry mechanics for routine spending. Describe the
transaction in plain language; the agent parses it, restates it, and confirms before posting.

```
You: log a transaction: $42 at Trader Joe's yesterday, from checking

Agent: Got it — $42.00 expense at Trader Joe's, dated 2026-06-30, from Assets:Checking.
       Posting against Expenses:Uncategorized. Confirm?
You: yes
Agent: Posted (transaction 57).
```

It always confirms date/amount/payee/account with you before calling the tool — there's no silent
posting. New transactions land in `Expenses:Uncategorized` or `Income:Uncategorized`; you clean
those up later (see §4) or let the agent do it for you as patterns emerge.

## 2. Bulk-importing a bank statement

Drop a CSV export in `data/inbox/` and point the agent at it, or upload it directly from the web
chat UI (upload button or drag-and-drop) — the server saves it to `data/inbox/` for you. Columns
are auto-detected.

```
You: import the CSV at data/inbox/chase_march.csv into Assets:Checking

Agent: Imported 18 row(s), skipped 2 likely duplicate(s), 1 error(s) out of 21 row(s).
       Errors: row 14 — unparseable amount "N/A".
       Skipped duplicates: row 9 (matches transaction 41), row 12 (matches transaction 44).
```

Re-importing the same file later is safe — every row that was already posted shows up as a
"likely duplicate" and is skipped, not double-posted. If a skip is wrong (it's not actually a
duplicate), say so and the agent re-calls with `force_duplicates: true`.

## 3. Capturing a receipt photo

```
You: read the receipt at data/inbox/receipt_20260701.jpg

Agent: I see: Trader Joe's, 2026-07-01, total $45.99. Items: groceries (not itemized).
       Post this as an expense from Assets:Checking?
You: yes
Agent: Posted (transaction 58), source_path recorded for audit.
```

If the image is blurry or a field is unreadable, the agent will say so explicitly ("uncertain
about the total — could be $45.99 or $48.99") and won't post until you confirm the correct value.
PDFs aren't supported yet — convert to an image first.

## 4. Cleaning up Uncategorized

```
You: show me the uncategorized expenses

Agent: 3 transactions in Expenses:Uncategorized:
       42 — 2026-06-28 — AMAZON.COM #112-4456 — $18.20
       45 — 2026-06-29 — AMAZON.COM #112-9981 — $12.50
       47 — 2026-06-30 — AMAZON MKTP US*7788 — $9.99

You: categorize all of those as Office Supplies

Agent: Categorized 3 transactions to Expenses:Office Supplies. Learned a rule for "amazon" —
       future Amazon charges will be suggested automatically.
```

Once a rule has fired twice it's "high confidence" and the agent will proactively suggest it
next time a matching charge comes in, rather than leaving it in Uncategorized. Corrections work
the same way — just re-categorize and the rule updates (last correction wins).

## 5. Asking about money — reports

Reporting tools are read-only; they never touch the ledger.

```
You: how much did I spend on food this year?
Agent: [calls spending_by_category] Expenses:Food: $1,240.50
         Expenses:Food:Groceries: $980.00
         Expenses:Food:Dining Out: $260.50

You: show the income statement for June 2026
Agent: [calls income_statement] Total Income: $5,000.00 | Total Expenses: $3,120.40
       | Net Income: $1,879.60

You: what's my balance sheet as of today?
Agent: [calls balance_sheet] Assets $12,400 = Liabilities $1,200 + Equity $11,200 ✓

You: export my 2025 taxes
Agent: [calls tax_year_export] Exported 214 transactions to data/exports/tax-export-2025.csv
```

## 6. When something's over the auto-post limit

Any post whose total debits exceed `auto_post_limit` (default $500, see `config/policies.yaml`)
is blocked until you explicitly approve it — this applies uniformly across manual entry, CSV
import, and receipt capture, not just `post_transaction`.

```
You: post a $5,000 equipment purchase from checking

Agent: Transaction exceeds auto-post limit of $500. Confirm you want to approve this?
You: yes, approve it
Agent: Posted (transaction 59) with approved: true.
```

The block itself is also logged to `memory/anomaly_log.json`, so large transactions leave a
paper trail even before you approve them.

## 7. Manual, structured posting (for anything the shortcuts don't cover)

For anything outside the "spend/receive money" shape — opening balances, transfers between your
own accounts, owner investments — post the full double-entry split yourself:

```
You: post a transaction:
     - date: 2026-07-01
     - description: Move savings to checking
     - debit Assets:Checking $500
     - credit Assets:Savings $500
```

The agent will reject it (and log the anomaly) if the splits don't sum to zero, or if an account
doesn't exist — it never invents a balancing figure or guesses an account.

## 8. Reconciling a bank statement

```
You: reconcile Assets:Checking against my June statement, ending balance $1,240.55, statement
     at data/inbox/checking_june.csv

Agent: [calls reconcile_account] 14 matched, 1 ledger-only, 0 statement-only. Discrepancy: $0.00.
       Preview only — say "mark it reconciled" to confirm.
You: mark it reconciled
Agent: [calls reconcile_account with markReconciled: true] Reconciliation run #3 recorded.
```

Reconciliation never edits transactions or splits — it only records which entries were matched in
this run. Ask for a `verify_ledger` check any time for a read-only integrity pass (unbalanced
transactions, orphan splits, trial balance).

## 9. Invoicing a customer and getting paid

```
You: invoice Acme Corp for 10 hours of consulting at $150/hr, due in 30 days, to Income:Consulting

Agent: [calls create_invoice] Invoice INV-2026-0001 created. Total: $1,500.00. Status: open.

You: Acme paid $500 from checking

Agent: [calls record_payment] Payment recorded. Invoice INV-2026-0001 status: partially paid
       ($1,000.00 remaining).
```

Invoices post real double-entry transactions immediately (debit Accounts Receivable, credit the
income account you name) — there's no separate draft-invoice state. Ask for an `ar_aging` report
any time to see who owes what, bucketed by how overdue they are. `render_invoice` produces a
plain-text copy of an invoice you can hand to the customer.

## What the agent will never do

- Post anything without restating it back to you first.
- Silently skip a likely-duplicate import row or a low-confidence receipt read — both always
  surface to you, and both require an explicit override after you've confirmed it's correct.
- Edit or delete a posted transaction's amount, date, or description. The only thing that's ever
  mutated in place is a split's category (`account_id`) during categorization — everything else
  is append-only, forever.
- Auto-post above the configured threshold without your approval.
- Accept a negative-quantity/negative-price invoice line item, or silently create a bank account
  for `record_payment` from a typo — both are rejected outright, not guessed at.

See `AGENTS.md` for the authoritative hard-rule list and `BRAIN.md` for domain details behind the
scenes above (duplicate-detection tolerance, retained-earnings calculation, etc.).
