/**
 * Receipt capture core: pi-agnostic, unit-testable.
 * Loads receipt images, posts them as balanced double-entry transactions.
 *
 * No `pi` import; takes the `Ledger` handle from `bookkeeping/ledger.ts`.
 */

import { readFileSync } from 'fs';
import { resolve, extname } from 'path';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { pdf } from 'pdf-to-img';
import { postTransaction, type Ledger } from '../bookkeeping/ledger.ts';
import { ensureUncategorizedAccount, type UncategorizedKind } from '../bank_sync/ingestion.ts';
import { findLikelyDuplicates, type DuplicateMatch } from '../bank_sync/dedupe.ts';

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
 * Rasterize a PDF file to a PNG image buffer.
 * Extracts the first page and returns the PNG buffer + total page count.
 * Throws a clear error for corrupted/password-protected PDFs.
 */
async function rasterizePdf(
  fileBuffer: Buffer
): Promise<{ pngBuffer: Buffer; pageCount: number }> {
  // pdf() from pdf-to-img returns an async iterable with a length property.
  // Its docs require calling destroy() to free the underlying pdfjs document.
  let document: Awaited<ReturnType<typeof pdf>> | undefined;
  try {
    document = await pdf(fileBuffer);

    if (!document || document.length === 0) {
      throw new Error('PDF has no extractable pages');
    }

    // Get page 1 (1-indexed) as a PNG Buffer
    const pngBuffer = await document.getPage(1);

    if (!pngBuffer) {
      throw new Error('Failed to extract first page');
    }

    const pageCount = document.length;

    return { pngBuffer, pageCount };
  } catch (err: any) {
    throw new Error(`Failed to rasterize PDF: ${err.message}`);
  } finally {
    await document?.destroy();
  }
}

/**
 * Load a receipt image from disk, resize it, and return base64-encoded data + MIME type.
 *
 * Supported formats: PNG, JPG, JPEG, GIF, WebP, PDF (first page only).
 * Unsupported formats are rejected with a clear error.
 *
 * Returns { data (base64), mimeType, pageCount? }.
 * pageCount is only set for PDFs and indicates the total number of pages.
 */
export async function loadReceiptImage(
  path: string
): Promise<{ data: string; mimeType: string; pageCount?: number }> {
  // Resolve path from cwd
  const resolvedPath = resolve(path);

  // Get file extension (basename-only, so dots in directory names don't confuse this)
  const ext = extname(resolvedPath).toLowerCase();

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

  let mimeType = 'image/png';
  let imageBuffer = fileBuffer;
  let pageCount: number | undefined;

  // Handle PDF files: rasterize to PNG
  if (ext === '.pdf') {
    const { pngBuffer, pageCount: count } = await rasterizePdf(fileBuffer);
    imageBuffer = pngBuffer;
    pageCount = count;
    mimeType = 'image/png';
  } else if (SUPPORTED_EXTENSIONS[ext]) {
    // Standard image formats
    mimeType = SUPPORTED_EXTENSIONS[ext];
  } else {
    // Unsupported extension
    throw new Error(
      `Unsupported file format: ${ext}. Supported formats are: PNG, JPG, JPEG, GIF, WebP, PDF.`
    );
  }

  // Resize the image using the utility from pi-coding-agent
  // Pass imageBuffer as Uint8Array (Buffer is a Uint8Array subclass)
  const resized = await resizeImage(imageBuffer, mimeType);

  // If resizing fails (Photon not available or image can't be resized below maxBytes),
  // fall back to using the original buffer base64-encoded
  let data: string;
  if (resized === null) {
    // Fallback: use original image bytes base64-encoded
    data = imageBuffer.toString('base64');
  } else {
    // Use the resized base64 data (already base64-encoded by resizeImage)
    data = resized.data;
  }

  return { data, mimeType, pageCount };
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
  force?: boolean; // override low-confidence and duplicate blocks
  approved?: boolean; // override auto-post threshold gate
  windowDays?: number; // duplicate detection date window (default: 3 days)
}

export type PostReceiptEntryResult =
  | { transactionId: number; splitIds: number[] }
  | { lowConfidence: string[] }
  | { duplicate: DuplicateMatch };

/**
 * Post a receipt entry as a balanced two-split transaction against
 * `account` and the inferred Uncategorized account (Expenses:Uncategorized
 * for expenses, Income:Uncategorized for income).
 *
 * Confidence gate: if confidence === 'low' && !force, returns { lowConfidence }
 * without posting, naming which fields are uncertain.
 *
 * Duplicate gate: if !force, checks for likely duplicates (same account, amount,
 * date window, fuzzy description match) and returns { duplicate } if found.
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
    windowDays,
  } = opts;

  // Confidence gate: block low-confidence posts unless forced
  if (confidence === 'low' && !force) {
    return {
      lowConfidence: uncertainFields ?? ['unspecified'],
    };
  }

  // Duplicate gate: block duplicate posts unless forced
  if (!force) {
    const duplicates = findLikelyDuplicates(ledger, {
      account,
      amountMinor,
      date,
      description: payee,
      windowDays,
    });
    if (duplicates.length > 0) {
      return { duplicate: duplicates[0] };
    }
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
