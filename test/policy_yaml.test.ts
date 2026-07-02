/**
 * Isolated test for the YAML branch of loadAutoPostLimitMinor. Lives in its own
 * file (rather than ledger.test.ts) because `tsx --test` runs each file listed
 * in package.json's "test" script in a separate process, giving this file a
 * fresh, unpopulated `cachedLimitMinor` module cache — a prerequisite no other
 * test in ledger.test.ts can offer once it has run a non-YAML load.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Policy loader: config/policies.yaml branch', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    delete process.env.BOOKKEEPING_AUTOPOST_LIMIT;
    tmpDir = mkdtempSync(join(tmpdir(), 'bookkeeping-policy-yaml-'));
    mkdirSync(join(tmpDir, 'config'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a negative auto_post_limit in config/policies.yaml', async () => {
    writeFileSync(join(tmpDir, 'config', 'policies.yaml'), 'auto_post_limit: -25\n', 'utf-8');
    process.chdir(tmpDir);

    const { loadAutoPostLimitMinor } = await import('../.pi/extensions/bookkeeping/policy.ts');
    assert.throws(
      () => loadAutoPostLimitMinor(),
      /config\/policies\.yaml auto_post_limit must be >= 0, got: -25/
    );
  });
});
