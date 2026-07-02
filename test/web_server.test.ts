import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/server.js";
import { getChatSession } from "../server/chatSession.js";
import type { Server } from "http";

describe("web_server", () => {
  let server: Server;
  let port: number;

  before(async () => {
    // Set test environment
    process.env.NODE_ENV = "test";

    // Create temp directory for test artifacts
    const tmpDir = mkdtempSync(join("/tmp", "bookkeeping-test-"));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, "anomaly.json");
    process.env.BOOKKEEPING_VENDOR_RULES_PATH = join(tmpDir, "vendors.json");

    // Create and start the server on an ephemeral port
    const app = createApp();
    server = app.listen(0); // 0 = ephemeral port
    port = (server.address() as any).port;
  });

  after(() => {
    server.close();
  });

  it("server responds to basic request (200 if built, 404 if not)", async () => {
    const response = await fetch(`http://localhost:${port}/`);
    // Accept either 200 (if web/dist exists) or 404 (if not yet built)
    assert.ok(response.status === 200 || response.status === 404);
  });

  it("POST /chat with missing message returns 400", async () => {
    const response = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(response.status, 400);
  });

  it("POST /chat with empty message returns 400", async () => {
    const response = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    assert.strictEqual(response.status, 400);
  });

  it("POST /chat with valid message returns text/event-stream and contains at least one SSE event", async () => {
    const response = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      response.headers.get("content-type"),
      "text/event-stream"
    );

    // Read and parse the stream
    const body = await response.text();
    const hasEvent =
      body.includes("event: delta") ||
      body.includes("event: error") ||
      body.includes("event: tool");
    assert.ok(hasEvent, "Response should contain at least one SSE event");
  });

  it("concurrent POST /chat returns 409", async () => {
    // Start first request (don't wait for it)
    const firstPromise = fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "First message" }),
    });

    // Give it a tiny bit of time to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Try second request
    const secondResponse = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Second message" }),
    });

    assert.strictEqual(secondResponse.status, 409);

    // Wait for first to complete
    const firstResponse = await firstPromise;
    assert.strictEqual(firstResponse.status, 200);
  });

  it("session tools exclude bash/read/edit/write and include ledger tools", async () => {
    const session = await getChatSession();
    // Get active tool names
    const activeToolNames = session.getActiveToolNames();

    // Should not have built-in tools
    assert.ok(!activeToolNames.includes("bash"), "Should not have bash tool");
    assert.ok(!activeToolNames.includes("read"), "Should not have read tool");
    assert.ok(!activeToolNames.includes("edit"), "Should not have edit tool");
    assert.ok(!activeToolNames.includes("write"), "Should not have write tool");

    // Should have at least one ledger tool to confirm extensions loaded
    const commonTools = [
      "list_accounts",
      "post_transaction",
      "get_balance",
    ];
    const hasLedgerTool = commonTools.some((tool) => activeToolNames.includes(tool));
    assert.ok(hasLedgerTool, `Should have at least one ledger tool. Available: ${activeToolNames.join(", ")}`);
  });
});
