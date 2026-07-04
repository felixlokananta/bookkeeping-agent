import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const EXPECTED_TOOL_ALLOWLIST = [
  // bookkeeping
  "list_accounts", "create_account", "post_transaction", "get_balance", "list_transactions",
  // bank_sync
  "log_transaction", "import_csv",
  // receipt_ocr
  "read_receipt", "capture_receipt",
  // categorization
  "list_uncategorized", "suggest_category", "apply_category",
  // reporting
  "spending_by_category", "income_statement", "balance_sheet", "tax_year_export",
  // reconciliation
  "reconcile_account", "verify_ledger",
  // invoicing
  "create_invoice", "list_invoices", "record_payment", "render_invoice", "ar_aging",
].sort();

const BUILTIN_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

describe("tool allowlist regression guard", () => {
  before(() => {
    process.env.NODE_ENV = "test";
    const tmpDir = mkdtempSync(join(tmpdir(), "bookkeeping-tool-allowlist-"));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, "anomaly.json");
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, "vendors.json");
    process.env.BOOKKEEPING_INBOX_DIR = join(tmpDir, "inbox");
  });

  it("exposes exactly the whitelisted bookkeeping tools — no builtins", async () => {
    // Boot the session exactly as server/chatSession.ts does: noTools:
    // "builtin" suppresses bash/read/edit/write, then bindExtensions()
    // fires session_start so extensions register + activate their tools.
    const { session } = await createAgentSession({ noTools: "builtin" });
    await session.bindExtensions({
      onError: (err) => { throw err; },
    });

    const activeToolNames = session.getActiveToolNames();

    for (const builtin of BUILTIN_TOOL_NAMES) {
      assert.ok(
        !activeToolNames.includes(builtin),
        `builtin tool "${builtin}" must not be active in the bookkeeping agent session`
      );
    }

    assert.deepStrictEqual(
      [...activeToolNames].sort(),
      EXPECTED_TOOL_ALLOWLIST,
      "active tool set must exactly match the hardcoded bookkeeping allowlist — " +
        "update EXPECTED_TOOL_ALLOWLIST if a tool was intentionally added/removed"
    );
  });
});
