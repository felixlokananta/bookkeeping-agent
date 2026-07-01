/**
 * Minimal CSV serializer.
 * Handles header row and proper quoting/escaping of fields.
 */

/**
 * Convert an array of row objects to CSV format.
 * Fields containing comma, quote, or newline are quoted and internal quotes are escaped.
 *
 * @param rows Array of row objects
 * @param columns Array of column names (keys to extract from rows)
 * @returns CSV string with header and data rows
 */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines: string[] = [];

  // Header row
  lines.push(quotedCsvRow(columns));

  // Data rows
  for (const row of rows) {
    const values = columns.map((col) => String(row[col] ?? ''));
    lines.push(quotedCsvRow(values));
  }

  return lines.join('\n');
}

/**
 * Convert an array of values to a quoted CSV row.
 * Each field is quoted if it contains comma, quote, or newline.
 * Internal quotes are doubled (CSV standard escaping).
 */
function quotedCsvRow(values: string[]): string {
  const quoted = values.map((val) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      // Escape quotes by doubling them
      const escaped = val.replace(/"/g, '""');
      return `"${escaped}"`;
    }
    return val;
  });
  return quoted.join(',');
}
