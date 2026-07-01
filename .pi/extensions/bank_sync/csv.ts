/**
 * CSV parsing core: pi-agnostic, unit-testable.
 * Hand-rolled, quoted-field-aware line parser (not a full RFC4180
 * implementation — no multi-line quoted fields). Covers the common
 * bank-export case: quoted fields, embedded commas, doubled-quote escaping.
 *
 * No `pi` or ledger imports. Row-level parse failures are returned as typed
 * error objects (never thrown) so the caller can continue processing
 * remaining rows and collect all errors; only file-level problems
 * (unreadable file, no recognizable columns and no overrides) throw.
 */

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export interface ColumnMap {
  dateCol: number;
  amountCol: number | null;
  debitCol: number | null;
  creditCol: number | null;
  descriptionCol: number;
  memoCol: number | null;
}

export interface ColumnOverrides {
  date_column?: string;
  amount_column?: string;
  debit_column?: string;
  credit_column?: string;
  description_column?: string;
  memo_column?: string;
}

const DATE_ALIASES = ['date', 'posted date', 'transaction date'];
const AMOUNT_ALIASES = ['amount'];
const DEBIT_ALIASES = ['debit'];
const CREDIT_ALIASES = ['credit'];
const DESCRIPTION_ALIASES = ['description', 'payee', 'name', 'memo'];
const MEMO_ALIASES = ['memo', 'notes'];

/**
 * Split a single CSV line into fields, honoring quoted fields with embedded
 * commas and doubled-quote escaping ("" -> "). Not multi-line aware.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse raw CSV text into a header row and data rows.
 * Handles \n and \r\n line endings; skips trailing blank lines.
 */
export function parseCsvText(text: string): ParsedCsv {
  const lines = text.split(/\r\n|\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { header: [], rows: [] };
  }
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => parseCsvLine(line));
  return { header, rows };
}

function findColumn(header: string[], aliases: string[]): number | null {
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return null;
}

function findColumnByName(header: string[], name: string): number {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const idx = normalized.indexOf(name.trim().toLowerCase());
  if (idx === -1) {
    throw new Error(`Column override '${name}' not found in header: ${header.join(', ')}`);
  }
  return idx;
}

/**
 * Detect (or resolve, via overrides) the column indices for date, amount
 * (or debit/credit), and description. Throws a clear error if no
 * recognizable columns are found and no overrides are given.
 */
export function detectColumns(header: string[], overrides?: ColumnOverrides): ColumnMap {
  const dateCol = overrides?.date_column
    ? findColumnByName(header, overrides.date_column)
    : findColumn(header, DATE_ALIASES);

  const amountCol = overrides?.amount_column
    ? findColumnByName(header, overrides.amount_column)
    : findColumn(header, AMOUNT_ALIASES);

  const debitCol = overrides?.debit_column
    ? findColumnByName(header, overrides.debit_column)
    : findColumn(header, DEBIT_ALIASES);

  const creditCol = overrides?.credit_column
    ? findColumnByName(header, overrides.credit_column)
    : findColumn(header, CREDIT_ALIASES);

  const descriptionCol = overrides?.description_column
    ? findColumnByName(header, overrides.description_column)
    : findColumn(header, DESCRIPTION_ALIASES);

  const memoColCandidate = overrides?.memo_column
    ? findColumnByName(header, overrides.memo_column)
    : findColumn(header, MEMO_ALIASES);

  // Set memoCol only if it differs from descriptionCol (avoid double-counting when both exist)
  const memoCol = memoColCandidate !== null && memoColCandidate !== descriptionCol ? memoColCandidate : null;

  if (dateCol === null || descriptionCol === null || (amountCol === null && (debitCol === null || creditCol === null))) {
    throw new Error(
      `No recognizable columns in CSV header (${header.join(', ') || '(empty)'}). ` +
        `Expected a date column, a description/payee column, and either an amount column or both debit and credit columns. ` +
        `Pass overrides (date_column, amount_column or debit_column/credit_column, description_column) to resolve.`
    );
  }

  return { dateCol, amountCol, debitCol, creditCol, descriptionCol, memoCol };
}

/**
 * Normalize a raw date string to ISO YYYY-MM-DD.
 * Accepts YYYY-MM-DD and MM/DD/YYYY. Throws on anything else.
 */
export function parseDate(raw: string): string {
  const trimmed = raw.trim();

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (m) {
    const [, y, mo, d] = m;
    if (isValidDateParts(Number(y), Number(mo), Number(d))) {
      return `${y}-${mo}-${d}`;
    }
    throw new Error(`Invalid date: ${raw}`);
  }

  // MM/DD/YYYY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (m) {
    const [, mo, d, y] = m;
    const moNum = Number(mo);
    const dNum = Number(d);
    if (isValidDateParts(Number(y), moNum, dNum)) {
      return `${y}-${String(moNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
    }
    throw new Error(`Invalid date: ${raw}`);
  }

  throw new Error(`Unparseable date: ${raw} (expected YYYY-MM-DD or MM/DD/YYYY)`);
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Parse a signed amount from a raw string, handling accounting-style
 * parenthesized negatives: (123.45) → -123.45, ($1,234.56) → -1234.56.
 * Strips $ and , characters, detects parentheses, and negates if present.
 * Throws if the resulting numeric text is empty or non-finite.
 */
function parseSignedAmount(raw: string): number {
  const trimmed = raw.trim();
  const parenMatch = /^\((.*)\)$/.exec(trimmed);
  const inner = parenMatch ? parenMatch[1] : trimmed;
  const stripped = inner.replace(/[$,]/g, '');

  if (!stripped) {
    throw new Error('Non-numeric amount');
  }

  const value = Number(stripped);
  if (!isFinite(value)) {
    throw new Error('Non-numeric amount');
  }

  return parenMatch ? -value : value;
}

/**
 * Parse unsigned amount from a string, stripping parentheses and currency
 * symbols but NOT negating (used for debit/credit columns where the formula
 * handles the sign).
 */
function parseUnsignedAmount(raw: string): number {
  const trimmed = raw.trim();
  // Strip parentheses without negating (they're just formatting in debit/credit context)
  const inner = trimmed.replace(/^\((.*)\)$/, '$1');
  const stripped = inner.replace(/[$,]/g, '');

  if (!stripped) {
    throw new Error('Non-numeric amount');
  }

  const value = Number(stripped);
  if (!isFinite(value)) {
    throw new Error('Non-numeric amount');
  }

  return value;
}

/**
 * Parse the signed amount (in minor units/cents) for a row, given resolved
 * column indices. Handles either a single signed `amount` column, or
 * separate `debit`/`credit` columns (credit - debit).
 * Throws on non-numeric input.
 */
export function parseAmountCents(row: string[], cols: ColumnMap): number {
  if (cols.amountCol !== null) {
    try {
      const value = parseSignedAmount(row[cols.amountCol] ?? '');
      return Math.round(value * 100);
    } catch {
      throw new Error(`Non-numeric amount: ${row[cols.amountCol]}`);
    }
  }

  if (cols.debitCol !== null && cols.creditCol !== null) {
    let debit = 0;
    let credit = 0;

    const rawDebit = (row[cols.debitCol] ?? '').trim();
    if (rawDebit) {
      try {
        debit = parseUnsignedAmount(rawDebit);
      } catch {
        throw new Error(`Non-numeric debit/credit: debit=${row[cols.debitCol]} credit=${row[cols.creditCol]}`);
      }
    }

    const rawCredit = (row[cols.creditCol] ?? '').trim();
    if (rawCredit) {
      try {
        credit = parseUnsignedAmount(rawCredit);
      } catch {
        throw new Error(`Non-numeric debit/credit: debit=${row[cols.debitCol]} credit=${row[cols.creditCol]}`);
      }
    }

    return Math.round((credit - debit) * 100);
  }

  throw new Error('No amount or debit/credit columns resolved');
}
