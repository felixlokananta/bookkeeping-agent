function parsePositiveIntEnv(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envVar} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function getMaxUploadBytes(): number {
  return parsePositiveIntEnv('BOOKKEEPING_MAX_UPLOAD_BYTES', 8 * 1024 * 1024); // 8MB default
}

export function getMaxAttachments(): number {
  return parsePositiveIntEnv('BOOKKEEPING_MAX_ATTACHMENTS', 5);
}

export function getMaxPdfPages(): number {
  return parsePositiveIntEnv('BOOKKEEPING_MAX_PDF_PAGES', 10);
}

export function getMaxImagesPerMessage(): number {
  return parsePositiveIntEnv('BOOKKEEPING_MAX_IMAGES_PER_MESSAGE', 15);
}

export const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export const SUPPORTED_CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/csv',
]);

export function getInboxDir(): string {
  return process.env.BOOKKEEPING_INBOX_DIR ?? 'data/inbox';
}
