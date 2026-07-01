/**
 * Money conversion helpers: major (dollars) <-> minor (cents) units.
 * All amounts are integers in the database (cents).
 * Tools accept major-unit floats and convert immediately.
 */

/**
 * Convert major units (dollars) to minor units (cents).
 * E.g., 12.50 -> 1250
 * Rounds to nearest cent using Math.round.
 * Throws if NaN or non-finite.
 */
export function toMinor(major: number): number {
  if (!isFinite(major)) {
    throw new Error(`Invalid amount: ${major} (must be a finite number)`);
  }
  const minor = Math.round(major * 100);
  if (!isFinite(minor)) {
    throw new Error(`Invalid amount: ${major} resulted in non-finite cents`);
  }
  return minor;
}

/**
 * Convert minor units (cents) to major units (dollars).
 * E.g., 1250 -> 12.50
 */
export function toMajor(minor: number): number {
  return minor / 100;
}

/**
 * Format an amount (in minor units) as a string with USD sign.
 * E.g., 1250 -> "12.50", -1250 -> "-12.50"
 */
export function formatMoney(minor: number): string {
  const major = toMajor(minor);
  return major.toFixed(2);
}
