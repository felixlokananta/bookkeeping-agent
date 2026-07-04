import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBindHost, assertSafeBindConfig } from "../server/network.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("server network config", () => {
  afterEach(() => {
    delete process.env.BOOKKEEPING_ALLOW_EXTERNAL_BIND;
  });

  it("defaults to binding localhost only", () => {
    assert.strictEqual(getBindHost(), "127.0.0.1");
  });

  it("binds externally only when BOOKKEEPING_ALLOW_EXTERNAL_BIND=true", () => {
    process.env.BOOKKEEPING_ALLOW_EXTERNAL_BIND = "true";
    assert.strictEqual(getBindHost(), "0.0.0.0");
  });

  it("assertSafeBindConfig throws for external bind without a token", () => {
    assert.throws(() => assertSafeBindConfig("0.0.0.0", undefined));
  });

  it("assertSafeBindConfig allows external bind with a token", () => {
    assert.doesNotThrow(() => assertSafeBindConfig("0.0.0.0", "secret"));
  });

  it("assertSafeBindConfig allows localhost bind without a token", () => {
    assert.doesNotThrow(() => assertSafeBindConfig("127.0.0.1", undefined));
  });

  it("server process refuses to start when external bind is enabled without an auth token", () => {
    // End-to-end guard against a future refactor (e.g. wrapping the
    // assertSafeBindConfig call in a try/catch) silently defeating the
    // safety check without any unit test noticing — actually spawn the
    // entrypoint and confirm the process itself dies before binding a port.
    const result = spawnSync("npx", ["tsx", "server/server.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BOOKKEEPING_ALLOW_EXTERNAL_BIND: "true",
        BOOKKEEPING_AUTH_TOKEN: "",
        PORT: "0",
      },
      encoding: "utf-8",
      timeout: 15000,
    });

    assert.notStrictEqual(
      result.status,
      0,
      `expected non-zero exit, got ${result.status}. stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /Refusing to bind/);
  });
});
