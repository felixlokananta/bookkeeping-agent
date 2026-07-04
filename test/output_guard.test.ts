import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanAssistantOutput,
  extractAssistantText,
  logBoundaryDisclosure,
} from "../server/outputGuard.js";

describe("scanAssistantOutput", () => {
  it("returns { flagged: false, matchedPatterns: [] } for null", () => {
    assert.deepStrictEqual(scanAssistantOutput(null), { flagged: false, matchedPatterns: [] });
  });

  it("returns { flagged: false, matchedPatterns: [] } for undefined", () => {
    assert.deepStrictEqual(scanAssistantOutput(undefined), { flagged: false, matchedPatterns: [] });
  });

  it("returns { flagged: false, matchedPatterns: [] } for empty string", () => {
    assert.deepStrictEqual(scanAssistantOutput(""), { flagged: false, matchedPatterns: [] });
  });

  it("does not flag ordinary bookkeeping text", () => {
    const result = scanAssistantOutput(
      "Posted $42.50 to Expenses:Office Supplies against Assets:Checking."
    );
    assert.deepStrictEqual(result, { flagged: false, matchedPatterns: [] });
  });

  it("flags an absolute /Users/ home directory path", () => {
    const result = scanAssistantOutput(
      "I'm operating from /Users/felixlokananta/PycharmProjects/bookkeeping-agent."
    );
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("absolute-home-path"));
  });

  it("flags an absolute /home/ directory path", () => {
    const result = scanAssistantOutput("Ledger files live under /home/operator/bookkeeping-agent");
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("absolute-home-path"));
  });

  it("flags a Windows-style user path", () => {
    const result = scanAssistantOutput("Ledger data is stored at C:\\Users\\operator\\ledger");
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("windows-user-path"));
  });

  it('flags a "cat .env" suggestion', () => {
    const result = scanAssistantOutput("You could run `cat .env` to check for one.");
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("env-file-shell-command"));
  });

  it('flags an "ls -la .env*" suggestion', () => {
    const result = scanAssistantOutput('Try: ls -la .env* 2>/dev/null || echo "No .env files found"');
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("env-file-shell-command"));
  });

  it('flags a reversed phrasing (".env" mentioned before the command)', () => {
    const result = scanAssistantOutput("Check .env by running cat on it");
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("env-file-shell-command-reversed"));
  });

  it("detects multiple patterns in a single response", () => {
    const result = scanAssistantOutput(
      "From /Users/felixlokananta/PycharmProjects/bookkeeping-agent, run `cat .env` to check."
    );
    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedPatterns.includes("absolute-home-path"));
    assert.ok(result.matchedPatterns.includes("env-file-shell-command"));
  });

  it("is case-insensitive for the env-file patterns", () => {
    const result = scanAssistantOutput("CAT .ENV");
    assert.strictEqual(result.flagged, true);
  });
});

describe("extractAssistantText", () => {
  it("returns empty string for null/undefined", () => {
    assert.strictEqual(extractAssistantText(null), "");
    assert.strictEqual(extractAssistantText(undefined), "");
  });

  it("returns empty string for a non-assistant message", () => {
    assert.strictEqual(
      extractAssistantText({ role: "user", content: [{ type: "text", text: "hi" }] }),
      ""
    );
  });

  it("returns empty string when content is not an array", () => {
    assert.strictEqual(extractAssistantText({ role: "assistant", content: "hi" }), "");
  });

  it("concatenates text parts in order", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello, " },
        { type: "text", text: "world." },
      ],
    };
    assert.strictEqual(extractAssistantText(message), "Hello, world.");
  });

  it("skips non-text parts (thinking, tool calls)", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", text: "internal reasoning" },
        { type: "tool_call", name: "list_accounts" },
        { type: "text", text: "Here are your accounts." },
      ],
    };
    assert.strictEqual(extractAssistantText(message), "Here are your accounts.");
  });
});

describe("logBoundaryDisclosure", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "output-guard-test-"));
    process.env.BOOKKEEPING_ANOMALY_LOG_PATH = join(tmpDir, "anomaly_log.json");
  });

  afterEach(() => {
    delete process.env.BOOKKEEPING_ANOMALY_LOG_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the log file with a single boundary_disclosure entry", () => {
    logBoundaryDisclosure("Possible internals-disclosure phrase(s) [absolute-home-path] in assistant response: /Users/x");
    const log = JSON.parse(readFileSync(process.env.BOOKKEEPING_ANOMALY_LOG_PATH!, "utf-8"));
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].kind, "boundary_disclosure");
    assert.ok(log[0].detail.includes("absolute-home-path"));
    assert.ok(typeof log[0].ts === "string");
  });

  it("appends to an existing log rather than overwriting it", () => {
    logBoundaryDisclosure("first");
    logBoundaryDisclosure("second");
    const log = JSON.parse(readFileSync(process.env.BOOKKEEPING_ANOMALY_LOG_PATH!, "utf-8"));
    assert.strictEqual(log.length, 2);
    assert.strictEqual(log[0].detail, "first");
    assert.strictEqual(log[1].detail, "second");
  });
});
