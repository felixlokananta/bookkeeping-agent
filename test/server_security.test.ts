import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { getBindHost, assertSafeBindConfig } from "../server/network.js";

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
});
