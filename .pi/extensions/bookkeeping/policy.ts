/**
 * Policy loader: reads the auto-post threshold from config/policies.yaml.
 * Also provides anomaly logging to memory/anomaly_log.json.
 *
 * Resolution order for threshold:
 * 1. env BOOKKEEPING_AUTOPOST_LIMIT (major units)
 * 2. config/policies.yaml auto_post_limit (major units)
 * 3. default 500.00 (major units)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { toMinor } from './money.js';

// @ts-ignore (yaml module is installed as a dependency)
import YAML from 'yaml';

let cachedLimitMinor: number | null = null;

/**
 * Load the auto-post limit in minor units (cents).
 * Caches the result; env override always wins.
 */
export function loadAutoPostLimitMinor(): number {
  // Env override always takes precedence
  const envOverride = process.env.BOOKKEEPING_AUTOPOST_LIMIT;
  if (envOverride !== undefined) {
    const major = parseFloat(envOverride);
    if (!isFinite(major)) {
      throw new Error(
        `BOOKKEEPING_AUTOPOST_LIMIT env var must be a valid number, got: ${envOverride}`
      );
    }
    return toMinor(major);
  }

  // Check cache (only if no env override)
  if (cachedLimitMinor !== null) {
    return cachedLimitMinor;
  }

  // Try to load from config/policies.yaml
  const policiesPath = join(process.cwd(), 'config', 'policies.yaml');
  let limitMajor = 500.0; // default

  try {
    const content = readFileSync(policiesPath, 'utf-8');
    const parsed = YAML.parse(content);
    if (parsed && typeof parsed.auto_post_limit === 'number') {
      limitMajor = parsed.auto_post_limit;
    }
  } catch (err) {
    // File missing or unreadable; fall back to default
    // console.warn(`Could not read policies.yaml, using default limit: ${limitMajor}`);
  }

  cachedLimitMinor = toMinor(limitMajor);
  return cachedLimitMinor;
}

/**
 * Check if a transaction can be auto-posted.
 * Returns { allowed, limitMinor }.
 * allowed = approved === true OR magnitudeMinor <= limitMinor
 */
export function checkAutoPost(
  magnitudeMinor: number,
  opts?: { approved?: boolean }
): { allowed: boolean; limitMinor: number } {
  const limitMinor = loadAutoPostLimitMinor();
  const approved = opts?.approved ?? false;
  const allowed = approved || magnitudeMinor <= limitMinor;
  return { allowed, limitMinor };
}

/**
 * Append an anomaly record to memory/anomaly_log.json.
 * Creates or repairs the file if needed.
 */
export function logAnomaly(entry: {
  kind: 'above_threshold' | 'imbalanced' | 'unknown_account';
  detail: string;
  magnitudeMinor?: number;
  limitMinor?: number;
}): void {
  const logPath = join(process.cwd(), 'memory', 'anomaly_log.json');
  let log: unknown[] = [];

  try {
    const content = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      log = parsed;
    }
  } catch {
    // File missing or malformed; start fresh
  }

  // Append the entry with a timestamp
  const record = {
    ts: new Date().toISOString(),
    kind: entry.kind,
    detail: entry.detail,
    ...(entry.magnitudeMinor !== undefined && {
      magnitudeMinor: entry.magnitudeMinor,
    }),
    ...(entry.limitMinor !== undefined && { limitMinor: entry.limitMinor }),
  };

  log.push(record);

  // Write back (synchronous for now; races acceptable at v1 volumes)
  writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
}
