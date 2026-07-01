/**
 * Rule schema and management for transaction categorization.
 * Rules are stored in memory/vendor_rules.json (path overridable via BOOKKEEPING_VENDOR_RULES_PATH).
 *
 * Rule format:
 * {
 *   "normalized_payee_pattern": {
 *     accountName: string,
 *     confidence: 'high' | 'low',
 *     hits: number,
 *     lastAppliedAt: string (ISO timestamp)
 *   }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export interface Rule {
  accountName: string;
  confidence: 'high' | 'low';
  hits: number;
  lastAppliedAt: string;
}

export interface Rules {
  [normalizedPattern: string]: Rule;
}

/**
 * Normalize a payee string for rule matching:
 * - Convert to lowercase
 * - Trim whitespace
 * - Replace punctuation with spaces (keep alphanumerics and spaces)
 */
export function normalizePayee(payee: string): string {
  return payee
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces, keep alphanumerics and spaces
    .replace(/\s+/g, ' ') // Collapse multiple spaces to single space
    .trim();
}

/**
 * Derive a generalizable vendor pattern from a raw transaction description.
 * Real bank/card descriptions often embed order numbers, reference codes, or
 * dates (e.g. "AMAZON.COM #12345", "TRADER JOE'S 123 SEATTLE WA") that make
 * two purchases from the same vendor normalize to different strings if used
 * verbatim as a rule pattern. This takes the leading run of non-numeric
 * tokens (the vendor name itself) and drops everything from the first
 * digit-bearing token onward, so repeat vendor charges share a pattern and
 * hits accumulate correctly.
 *
 * Falls back to the full normalized description if the numeric-stripped
 * prefix is too short (<3 chars) to be a meaningful pattern (e.g. the
 * description starts with a digit).
 */
export function extractVendorPattern(description: string): string {
  const normalized = normalizePayee(description);
  const tokens = normalized.split(' ').filter(Boolean);

  const prefixTokens: string[] = [];
  for (const token of tokens) {
    if (/\d/.test(token)) break;
    prefixTokens.push(token);
    if (prefixTokens.length >= 4) break;
  }

  const candidate = prefixTokens.join(' ');
  return candidate.length >= 3 ? candidate : normalized;
}

/**
 * Load rules from disk (vendor_rules.json).
 * Path defaults to memory/vendor_rules.json, overridable via BOOKKEEPING_VENDOR_RULES_PATH env var.
 * Returns {} if file doesn't exist.
 */
export function loadRules(): Rules {
  const rulesPath =
    process.env.BOOKKEEPING_VENDOR_RULES_PATH || resolve('./memory/vendor_rules.json');

  try {
    const content = readFileSync(rulesPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // File doesn't exist or invalid JSON; return empty
    return {};
  }
}

/**
 * Save rules to disk.
 * Creates parent directories as needed.
 */
export function saveRules(rules: Rules): void {
  const rulesPath =
    process.env.BOOKKEEPING_VENDOR_RULES_PATH || resolve('./memory/vendor_rules.json');

  const dir = dirname(rulesPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
}

/**
 * Find the best matching rule for a payee string.
 * Performs normalized substring matching: if the normalized payee contains
 * a normalized rule pattern, it's a match.
 *
 * Returns the rule with the highest pattern length (most specific match),
 * or null if no match.
 */
export function matchRule(payee: string, rules: Rules): { pattern: string; rule: Rule } | null {
  const normalizedPayee = normalizePayee(payee);

  let bestMatch: { pattern: string; rule: Rule } | null = null;
  let bestMatchLength = 0;

  for (const [pattern, rule] of Object.entries(rules)) {
    // Check if normalized payee contains this pattern
    if (normalizedPayee.includes(pattern)) {
      // Prefer the longest (most specific) match
      if (pattern.length > bestMatchLength) {
        bestMatch = { pattern, rule };
        bestMatchLength = pattern.length;
      }
    }
  }

  return bestMatch;
}

/**
 * Upsert a rule into the rules map.
 * If a rule with the same pattern already exists:
 *   - If it points to the same accountName, increment hits and update lastAppliedAt
 *   - If it points to a different accountName, overwrite (last-write-wins correction)
 * If no rule exists for the pattern, create it with hits=1
 */
export function upsertRule(
  rules: Rules,
  pattern: string,
  accountName: string,
  now: string = new Date().toISOString()
): Rules {
  const normalized = normalizePayee(pattern);

  if (normalized in rules) {
    const existingRule = rules[normalized];
    if (existingRule.accountName === accountName) {
      // Same account; increment hits
      existingRule.hits += 1;
    } else {
      // Different account; overwrite (correction)
      rules[normalized] = {
        accountName,
        confidence: 'low',
        hits: 1,
        lastAppliedAt: now,
      };
    }
    // Always update lastAppliedAt
    rules[normalized].lastAppliedAt = now;
    // Update confidence based on hits
    rules[normalized].confidence = rules[normalized].hits >= 2 ? 'high' : 'low';
  } else {
    // Create new rule
    rules[normalized] = {
      accountName,
      confidence: 'low',
      hits: 1,
      lastAppliedAt: now,
    };
  }

  return rules;
}
