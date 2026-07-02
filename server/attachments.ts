import { pdf } from 'pdf-to-img';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  getMaxUploadBytes,
  getMaxAttachments,
  getMaxPdfPages,
  getMaxImagesPerMessage,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
  SUPPORTED_CSV_MIME_TYPES,
  getInboxDir,
} from './uploadConfig.js';

export class AttachmentError extends Error {}

export interface Attachment {
  filename: string;
  mimeType: string;
  data: string; // base64, no "data:...;base64," prefix
}

export interface ProcessedImage {
  type: 'image';
  data: string;
  mimeType: string;
}

function isCsvAttachment(att: Attachment): boolean {
  if (SUPPORTED_CSV_MIME_TYPES.has(att.mimeType)) return true;
  return att.mimeType === '' && att.filename.toLowerCase().endsWith('.csv');
}

// Mirrors .pi/extensions/receipt_ocr/capture.ts's post-load resizeImage step:
// AgentSession.prompt() forwards image content parts to the model API as-is
// (no resizing of its own), so an uploaded photo or a rasterized PDF page
// left at full size risks being rejected or degraded by provider-side image
// limits. Falls back to the original bytes, base64-encoded, if Photon isn't
// available (resizeImage returns null) — same fallback capture.ts relies on.
async function toResizedImage(buffer: Buffer, mimeType: string): Promise<ProcessedImage> {
  const resized = await resizeImage(buffer, mimeType);
  if (resized === null) {
    return { type: 'image', data: buffer.toString('base64'), mimeType };
  }
  return { type: 'image', data: resized.data, mimeType: resized.mimeType };
}

// Mirrors .pi/extensions/receipt_ocr/capture.ts's rasterizePdf, extended to
// all pages (up to maxPages) instead of just page 1, and must call
// document.destroy() in finally — see commit 54df7f1 which fixed a handle
// leak in the single-page version this is modeled on.
async function rasterizePdfPages(fileBuffer: Buffer, maxPages: number): Promise<Buffer[]> {
  let document: Awaited<ReturnType<typeof pdf>> | undefined;
  try {
    document = await pdf(fileBuffer);
    if (!document || document.length === 0) {
      throw new AttachmentError('PDF has no extractable pages');
    }
    const pageCount = Math.min(document.length, maxPages);
    const pages: Buffer[] = [];
    for (let i = 1; i <= pageCount; i++) {
      pages.push(await document.getPage(i));
    }
    return pages;
  } catch (err: any) {
    if (err instanceof AttachmentError) throw err;
    throw new AttachmentError(`Failed to rasterize PDF: ${err.message}`);
  } finally {
    await document?.destroy();
  }
}

export async function processAttachments(attachments: Attachment[]): Promise<{ images: ProcessedImage[]; csvPaths: string[] }> {
  if (attachments.length === 0) return { images: [], csvPaths: [] };

  const maxAttachments = getMaxAttachments();
  if (attachments.length > maxAttachments) {
    throw new AttachmentError(`Too many attachments: ${attachments.length} (max ${maxAttachments} per message)`);
  }

  const maxUploadBytes = getMaxUploadBytes();
  const maxPdfPages = getMaxPdfPages();
  const maxImages = getMaxImagesPerMessage();
  const images: ProcessedImage[] = [];
  const csvPaths: string[] = [];

  for (const att of attachments) {
    if (!att || typeof att.filename !== 'string' || typeof att.mimeType !== 'string' || typeof att.data !== 'string') {
      throw new AttachmentError('Malformed attachment: filename, mimeType, and data are required');
    }
    if (!SUPPORTED_ATTACHMENT_MIME_TYPES.has(att.mimeType) && !isCsvAttachment(att)) {
      throw new AttachmentError(`Unsupported file type "${att.mimeType}" for "${att.filename}". Supported: PNG, JPG, GIF, WebP, PDF, CSV.`);
    }

    const raw = Buffer.from(att.data, 'base64');
    if (raw.byteLength === 0) {
      throw new AttachmentError(`"${att.filename}" is empty`);
    }
    if (raw.byteLength > maxUploadBytes) {
      throw new AttachmentError(
        `"${att.filename}" is too large (${Math.ceil(raw.byteLength / 1024 / 1024)}MB, max ${Math.ceil(maxUploadBytes / 1024 / 1024)}MB)`
      );
    }

    if (isCsvAttachment(att)) {
      const dir = getInboxDir();
      mkdirSync(dir, { recursive: true });
      const safeName = basename(att.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      const uniqueName = `${Date.now()}-${randomBytes(4).toString('hex')}-${safeName}`;
      const fullPath = join(dir, uniqueName);
      writeFileSync(fullPath, raw);
      csvPaths.push(fullPath);
    } else if (att.mimeType === 'application/pdf') {
      const pages = await rasterizePdfPages(raw, maxPdfPages);
      for (const pageBuffer of pages) {
        images.push(await toResizedImage(pageBuffer, 'image/png'));
      }
    } else {
      images.push(await toResizedImage(raw, att.mimeType));
    }

    if (images.length > maxImages) {
      throw new AttachmentError(`Too many images after processing (max ${maxImages} per message; PDFs expand to one image per page)`);
    }
  }

  return { images, csvPaths };
}
