import { describe, it } from "node:test";
import assert from "node:assert";
import { detectAutoPostBlock, type ApprovalRequiredPayload } from "../server/approvalDetection.js";

describe("detectAutoPostBlock", () => {
  const toolCallId = "call-123";

  it("returns null when isError is false", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      { amount: -600, account: "Assets:Checking", payee: "Big Purchase" },
      { content: [{ type: "text", text: "Transaction posted successfully" }] },
      false // isError
    );
    assert.strictEqual(result, null);
  });

  it("returns null when isError is true but text doesn't match the auto-post pattern", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      { amount: -600, account: "Assets:Checking", payee: "Big Purchase" },
      { content: [{ type: "text", text: "Likely duplicate of existing transaction..." }] },
      true // isError
    );
    assert.strictEqual(result, null);
  });

  it("returns null when result is undefined", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      { amount: -600, account: "Assets:Checking", payee: "Big Purchase" },
      undefined,
      true // isError
    );
    assert.strictEqual(result, null);
  });

  it("returns null when result.content is empty", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      { amount: -600, account: "Assets:Checking", payee: "Big Purchase" },
      { content: [] },
      true // isError
    );
    assert.strictEqual(result, null);
  });

  it("returns null when result.content[0].text is missing", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      { amount: -600, account: "Assets:Checking", payee: "Big Purchase" },
      { content: [{ type: "text" }] },
      true // isError
    );
    assert.strictEqual(result, null);
  });

  it("extracts approval info from log_transaction args with negative amount", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      {
        date: "2026-01-15",
        amount: -600,
        account: "Assets:Checking",
        payee: "Big Purchase",
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.deepStrictEqual(result, {
      toolCallId,
      toolName: "log_transaction",
      description: "Big Purchase",
      amount: 600,
      accounts: ["Assets:Checking"],
      limit: 500,
    } as ApprovalRequiredPayload);
  });

  it("extracts approval info from capture_receipt args", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "capture_receipt",
      {
        date: "2026-01-15",
        amount: -750,
        account: "Assets:Checking",
        payee: "Office Depot",
        source_path: "/tmp/receipt.png",
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.deepStrictEqual(result, {
      toolCallId,
      toolName: "capture_receipt",
      description: "Office Depot",
      amount: 750,
      accounts: ["Assets:Checking"],
      limit: 500,
    } as ApprovalRequiredPayload);
  });

  it("extracts approval info from post_transaction args", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "post_transaction",
      {
        date: "2026-01-15",
        description: "Big Purchase",
        splits: [
          { account: "Expenses:Equipment", amount: 600 },
          { account: "Assets:Checking", amount: -600 },
        ],
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.deepStrictEqual(result, {
      toolCallId,
      toolName: "post_transaction",
      description: "Big Purchase",
      amount: 600,
      accounts: ["Expenses:Equipment", "Assets:Checking"],
      limit: 500,
    } as ApprovalRequiredPayload);
  });

  it("parses comma-formatted limit correctly", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      {
        date: "2026-01-15",
        amount: -1500,
        account: "Assets:Checking",
        payee: "Expensive Item",
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $1,200.00. Set approved: true to override." }] },
      true // isError
    );

    assert.deepStrictEqual(result, {
      toolCallId,
      toolName: "log_transaction",
      description: "Expensive Item",
      amount: 1500,
      accounts: ["Assets:Checking"],
      limit: 1200,
    } as ApprovalRequiredPayload);
  });

  it("uses default description 'Transaction' when payee is missing in log_transaction", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      {
        date: "2026-01-15",
        amount: -600,
        account: "Assets:Checking",
        // no payee
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.strictEqual(result?.description, "Transaction");
  });

  it("uses default description 'Transaction' when description is missing in post_transaction", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "post_transaction",
      {
        date: "2026-01-15",
        // no description
        splits: [
          { account: "Expenses:Equipment", amount: 600 },
          { account: "Assets:Checking", amount: -600 },
        ],
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.strictEqual(result?.description, "Transaction");
  });

  it("handles post_transaction with no positive splits (amount becomes 0)", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "post_transaction",
      {
        date: "2026-01-15",
        description: "All negative splits",
        splits: [
          { account: "Assets:Checking", amount: -600 },
        ],
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.strictEqual(result?.amount, 0);
  });

  it("filters out non-string accounts from post_transaction splits", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "post_transaction",
      {
        date: "2026-01-15",
        description: "Mixed splits",
        splits: [
          { account: "Expenses:Equipment", amount: 300 },
          { account: null, amount: 300 }, // should be filtered out
          { account: "Assets:Checking", amount: -600 },
          { amount: 300 }, // no account at all
        ],
      },
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    assert.deepStrictEqual(result?.accounts, ["Expenses:Equipment", "Assets:Checking"]);
  });

  it("handles malformed args gracefully", () => {
    const result = detectAutoPostBlock(
      toolCallId,
      "log_transaction",
      null, // malformed args
      { content: [{ type: "text", text: "Transaction exceeds auto-post limit of $500.00. Set approved: true to override." }] },
      true // isError
    );

    // Should return an approval payload with defaults, not crash
    assert.ok(result);
    assert.strictEqual(result.description, "Transaction");
    assert.strictEqual(result.amount, 0);
    assert.deepStrictEqual(result.accounts, []);
  });
});
