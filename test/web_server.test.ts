import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/server.js";
import { getChatSession, setIsStreaming } from "../server/chatSession.js";
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

  it("concurrent POST /chat returns 409 while a request is in flight", async () => {
    // This can't be tested by racing two real HTTP requests against each
    // other: the window during which the lock is held is entirely
    // determined by how long session.prompt()'s upstream model call takes,
    // which this test doesn't control. Locally (with an authenticated ~/.pi
    // session) that call is slow (real network round trip), so two
    // overlapping requests reliably collide. In CI there's no model
    // credential, so the call fails immediately and the *entire* request
    // (lock set -> error -> lock released) completes within a handful of
    // synchronous microtask turns -- faster than the client can even
    // observe the first response, let alone dispatch a second request into
    // the lock window. So instead, drive the lock directly to test the
    // actual contract: reject while streaming, accept once released.
    setIsStreaming(true);
    try {
      const response = await fetch(`http://localhost:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Second message" }),
      });
      assert.strictEqual(response.status, 409);
    } finally {
      setIsStreaming(false);
    }

    const followUp = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Follow-up message" }),
    });
    assert.strictEqual(followUp.status, 200);
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

  describe("POST /chat with attachments", () => {
    it("with valid PNG attachment and empty message returns 200 text/event-stream", async () => {
      // Reset streaming state from previous test
      setIsStreaming(false);

      const pngBuffer = readFileSync(join(process.cwd(), "test/fixtures/receipt.png"));
      const pngBase64 = pngBuffer.toString("base64");

      const response = await fetch(`http://localhost:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "",
          attachments: [
            {
              filename: "receipt.png",
              mimeType: "image/png",
              data: pngBase64,
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("content-type"), "text/event-stream");

      // Read and parse the stream
      const body = await response.text();
      const hasEvent =
        body.includes("event: delta") ||
        body.includes("event: error") ||
        body.includes("event: tool");
      assert.ok(hasEvent, "Response should contain at least one SSE event");
    });

    it("with unsupported MIME type returns 400 with error message", async () => {
      const response = await fetch(`http://localhost:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Process this file",
          attachments: [
            {
              filename: "document.txt",
              mimeType: "text/plain",
              data: "dGhpcyBpcyBub3QgYW4gaW1hZ2U=", // base64 dummy
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 400);
      const data = await response.json();
      assert.ok(data.error);
      assert.match(data.error, /Unsupported file type/);
    });

    it("with attachments not an array returns 400", async () => {
      const response = await fetch(`http://localhost:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Process this file",
          attachments: "not an array",
        }),
      });

      assert.strictEqual(response.status, 400);
      const data = await response.json();
      assert.ok(data.error);
      assert.match(data.error, /attachments must be an array/);
    });

    it("with oversized attachment returns 400", async () => {
      const originalLimit = process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
      process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = "10"; // 10 bytes max

      const pngBuffer = readFileSync(join(process.cwd(), "test/fixtures/receipt.png"));
      const pngBase64 = pngBuffer.toString("base64");

      try {
        const response = await fetch(`http://localhost:${port}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Process this file",
            attachments: [
              {
                filename: "receipt.png",
                mimeType: "image/png",
                data: pngBase64,
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 400);
        const data = await response.json();
        assert.ok(data.error);
        assert.match(data.error, /too large/);
      } finally {
        // Restore original limit
        if (originalLimit === undefined) {
          delete process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
        } else {
          process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = originalLimit;
        }
      }
    });

    it("with a request body over the express.json() limit returns 413 as JSON, not HTML", async () => {
      // express.json()'s limit is derived from BOOKKEEPING_MAX_UPLOAD_BYTES *
      // BOOKKEEPING_MAX_ATTACHMENTS * 2. Shrinking both to tiny values makes
      // an ordinary-sized body exceed the limit without allocating a huge
      // string in the test itself.
      const originalBytes = process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
      const originalAttachments = process.env.BOOKKEEPING_MAX_ATTACHMENTS;
      process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = "10";
      process.env.BOOKKEEPING_MAX_ATTACHMENTS = "1";

      try {
        // A fresh app picks up the shrunken limit (createApp() reads it at
        // construction time); the shared `port` server was built with the
        // default limit, so build a throwaway app/server for this case.
        const { createApp } = await import("../server/server.js");
        const oversizedApp = createApp();
        const oversizedServer = oversizedApp.listen(0);
        const oversizedPort = (oversizedServer.address() as any).port;

        try {
          const response = await fetch(`http://localhost:${oversizedPort}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "x",
              attachments: [{ filename: "big.png", mimeType: "image/png", data: "A".repeat(1000) }],
            }),
          });

          assert.strictEqual(response.status, 413);
          assert.match(response.headers.get("content-type") ?? "", /application\/json/);
          const data = await response.json();
          assert.ok(data.error);
        } finally {
          oversizedServer.close();
        }
      } finally {
        if (originalBytes === undefined) {
          delete process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
        } else {
          process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = originalBytes;
        }
        if (originalAttachments === undefined) {
          delete process.env.BOOKKEEPING_MAX_ATTACHMENTS;
        } else {
          process.env.BOOKKEEPING_MAX_ATTACHMENTS = originalAttachments;
        }
      }
    });
  });

  it("POST /chat with empty message and no attachments still returns 400 (confirm backward compatibility)", async () => {
    // Reset streaming state from previous tests
    setIsStreaming(false);

    const response = await fetch(`http://localhost:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    assert.strictEqual(response.status, 400);
    const data = await response.json();
    assert.ok(data.error);
    assert.match(data.error, /Missing or empty message/);
  });
});
