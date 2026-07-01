/**
 * Receipt capture core: pi-agnostic, unit-testable.
 * Loads receipt images, posts them as balanced double-entry transactions.
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { postTransaction, type Ledger } from '../bookkeeping/ledger.ts';
import { ensureUncategorizedAccount, type UncategorizedKind } from '../bank_sync/ingestion.ts';

/**
 * Supported image MIME types and their file extensions.
 */
const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Load a receipt image from disk, resize it, and return base64-encoded data + MIME type.
 *
 * Supported formats: PNG, JPG, JPEG, GIF, WebP.
 * PDF and unsupported formats are rejected with a clear error.
 *
 * Returns { data (base64), mimeType }.
 */
export function loadReceiptImage(path: string): { data: string; mimeType: string } {
  // Resolve path from cwd
  const resolvedPath = resolve(path);

  // Get file extension
  const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();

  // Check for PDF explicitly
  if (ext === '.pdf') {
    throw new Error(
      'PDF files are not yet supported. Please convert the PDF to an image format (PNG, JPG, GIF, or WebP) and try again.'
    );
  }

  // Check if extension is supported
  if (!SUPPORTED_EXTENSIONS[ext]) {
    throw new Error(
      `Unsupported file format: ${ext}. Supported formats are: PNG, JPG, JPEG, GIF, WebP.`
    );
  }

  // Read the file
  let fileBuffer: Buffer;
  try {
    fileBuffer = readFileSync(resolvedPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Receipt file not found: ${path}`);
    }
    throw new Error(`Failed to read receipt file: ${err.message}`);
  }

  // Resize the image using the utility from pi-coding-agent
  const resizedBuffer = resizeImage(fileBuffer);

  // Convert to base64
  const data = resizedBuffer.toString('base64');
  const mimeType = SUPPORTED_EXTENSIONS[ext];

  return { data, mimeType };
}

export interface PostReceiptEntryOptions {
  date: string;
  amountMinor: number; // signed: negative = expense, positive = income
  account: string | number; // source account
  payee: string;
  memo?: string;
  sourcePath: string; // path to the receipt image
  confidence: 'high' | 'low';
  uncertainFields?: string[];
  force?: boolean; // override low-confidence block
  approved?: boolean; // override auto-post threshold gate
}

export type PostReceiptEntryResult =
  | { transactionId: number; splitIds: number[] }
  | { lowConfidence: string[] };

/**
 * Post a receipt entry as a balanced two-split transaction against
 * `account` and the inferred Uncategorized account (Expenses:Uncategorized
 * for expenses, Income:Uncategorized for income).
 *
 * Confidence gate: if confidence === 'low' && !force, returns { lowConfidence }
 * without posting, naming which fields are uncertain.
 *
 * Re-throws postTransaction errors (imbalance/threshold) unchanged.
 */
export function postReceiptEntry(
  ledger: Ledger,
  opts: PostReceiptEntryOptions
): PostReceiptEntryResult {
  const {
    date,
    amountMinor,
    account,
    payee,
    memo,
    sourcePath,
    confidence,
    uncertainFields,
    force,
    approved,
  } = opts;

  // Confidence gate: block low-confidence posts unless forced
  if (confidence === 'low' && !force) {
    return {
      lowConfidence: uncertainFields ?? ['unspecified'],
    };
  }

  // Determine the offsetting Uncategorized account kind
  const kind: UncategorizedKind = amountMinor < 0 ? 'expense' : 'income';
  const uncategorized = ensureUncategorizedAccount(ledger, kind);

  // Post the transaction
  const result = postTransaction(ledger, {
    date,
    description: payee,
    sourcePath,
    splits: [
      { account, amount: amountMinor, memo },
      { account: uncategorized.id, amount: -amountMinor },
    ],
    approved,
  });

  return result;
}
