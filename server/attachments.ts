import { pdf } from 'pdf-to-img';
import {
  getMaxUploadBytes,
  getMaxAttachments,
  getMaxPdfPages,
  getMaxImagesPerMessage,
  SUPPORTED_ATTACHMENT_MIME_TYPES,
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

export async function processAttachments(attachments: Attachment[]): Promise<ProcessedImage[]> {
  if (attachments.length === 0) return [];

  const maxAttachments = getMaxAttachments();
  if (attachments.length > maxAttachments) {
    throw new AttachmentError(`Too many attachments: ${attachments.length} (max ${maxAttachments} per message)`);
  }

  const maxUploadBytes = getMaxUploadBytes();
  const maxPdfPages = getMaxPdfPages();
  const maxImages = getMaxImagesPerMessage();
  const images: ProcessedImage[] = [];

  for (const att of attachments) {
    if (!att || typeof att.filename !== 'string' || typeof att.mimeType !== 'string' || typeof att.data !== 'string') {
      throw new AttachmentError('Malformed attachment: filename, mimeType, and data are required');
    }
    if (!SUPPORTED_ATTACHMENT_MIME_TYPES.has(att.mimeType)) {
      throw new AttachmentError(`Unsupported file type "${att.mimeType}" for "${att.filename}". Supported: PNG, JPG, GIF, WebP, PDF.`);
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

    if (att.mimeType === 'application/pdf') {
      const pages = await rasterizePdfPages(raw, maxPdfPages);
      for (const pageBuffer of pages) {
        images.push({ type: 'image', data: pageBuffer.toString('base64'), mimeType: 'image/png' });
      }
    } else {
      images.push({ type: 'image', data: att.data, mimeType: att.mimeType });
    }

    if (images.length > maxImages) {
      throw new AttachmentError(`Too many images after processing (max ${maxImages} per message; PDFs expand to one image per page)`);
    }
  }

  return images;
}
