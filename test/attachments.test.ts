/**
 * Attachment processing unit tests.
 * Tests processAttachments function (validation, PDF rasterization).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAttachments, AttachmentError, type Attachment } from '../server/attachments.js';

describe('Attachment processing', () => {
  const fixtureDir = join(process.cwd(), 'test/fixtures');

  // Load and base64-encode fixtures
  const loadFixture = (filename: string): string => {
    const buffer = readFileSync(join(fixtureDir, filename));
    return buffer.toString('base64');
  };

  describe('Image passthrough', () => {
    it('should pass through PNG images unchanged', async () => {
      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'receipt.png',
          mimeType: 'image/png',
          data: pngData,
        },
      ];

      const result = await processAttachments(attachments);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'image');
      assert.strictEqual(result[0].mimeType, 'image/png');
      assert.strictEqual(result[0].data, pngData);
    });

    it('should pass through JPEG images unchanged', async () => {
      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'receipt.jpg',
          mimeType: 'image/jpeg',
          data: pngData, // reuse PNG data for test purposes
        },
      ];

      const result = await processAttachments(attachments);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'image');
      assert.strictEqual(result[0].mimeType, 'image/jpeg');
      assert.strictEqual(result[0].data, pngData);
    });
  });

  describe('PDF rasterization', () => {
    it('should rasterize single-page PDF to one PNG image', async () => {
      const pdfData = loadFixture('receipt.pdf');
      const attachments: Attachment[] = [
        {
          filename: 'receipt.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      ];

      const result = await processAttachments(attachments);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'image');
      assert.strictEqual(result[0].mimeType, 'image/png');

      // Verify it's valid PNG by checking magic bytes
      const decoded = Buffer.from(result[0].data, 'base64');
      assert.ok(decoded.length >= 4, 'PNG should be at least 4 bytes');
      assert.strictEqual(decoded[0], 0x89, 'PNG magic byte 1');
      assert.strictEqual(decoded[1], 0x50, 'PNG magic byte 2');
      assert.strictEqual(decoded[2], 0x4e, 'PNG magic byte 3');
      assert.strictEqual(decoded[3], 0x47, 'PNG magic byte 4');
    });

    it('should rasterize multi-page PDF to multiple PNG images', async () => {
      const pdfData = loadFixture('receipt-multipage.pdf');
      const attachments: Attachment[] = [
        {
          filename: 'receipt-multipage.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      ];

      const result = await processAttachments(attachments);

      // The multipage fixture should have exactly 2 pages
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, 'image');
      assert.strictEqual(result[0].mimeType, 'image/png');
      assert.strictEqual(result[1].type, 'image');
      assert.strictEqual(result[1].mimeType, 'image/png');

      // Verify both are valid PNGs
      for (const img of result) {
        const decoded = Buffer.from(img.data, 'base64');
        assert.ok(decoded.length >= 4);
        assert.strictEqual(decoded[0], 0x89);
      }
    });

    it('should respect BOOKKEEPING_MAX_PDF_PAGES limit', async () => {
      const originalLimit = process.env.BOOKKEEPING_MAX_PDF_PAGES;
      process.env.BOOKKEEPING_MAX_PDF_PAGES = '1';

      const pdfData = loadFixture('receipt-multipage.pdf');
      const attachments: Attachment[] = [
        {
          filename: 'receipt-multipage.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      ];

      const result = await processAttachments(attachments);

      // Only 1 page should be rasterized despite the PDF having 2 pages
      assert.strictEqual(result.length, 1);

      // Restore original limit
      if (originalLimit === undefined) {
        delete process.env.BOOKKEEPING_MAX_PDF_PAGES;
      } else {
        process.env.BOOKKEEPING_MAX_PDF_PAGES = originalLimit;
      }
    });
  });

  describe('Validation errors', () => {
    it('should reject unsupported MIME type', async () => {
      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'document.txt',
          mimeType: 'text/plain',
          data: pngData,
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /Unsupported file type/);
          return true;
        }
      );
    });

    it('should reject oversized files', async () => {
      const originalLimit = process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
      process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = '10'; // 10 bytes max

      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'receipt.png',
          mimeType: 'image/png',
          data: pngData,
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /too large/);
          return true;
        }
      );

      // Restore original limit
      if (originalLimit === undefined) {
        delete process.env.BOOKKEEPING_MAX_UPLOAD_BYTES;
      } else {
        process.env.BOOKKEEPING_MAX_UPLOAD_BYTES = originalLimit;
      }
    });

    it('should reject too many attachments', async () => {
      const originalLimit = process.env.BOOKKEEPING_MAX_ATTACHMENTS;
      process.env.BOOKKEEPING_MAX_ATTACHMENTS = '1'; // Max 1 attachment

      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'receipt1.png',
          mimeType: 'image/png',
          data: pngData,
        },
        {
          filename: 'receipt2.png',
          mimeType: 'image/png',
          data: pngData,
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /Too many attachments/);
          return true;
        }
      );

      // Restore original limit
      if (originalLimit === undefined) {
        delete process.env.BOOKKEEPING_MAX_ATTACHMENTS;
      } else {
        process.env.BOOKKEEPING_MAX_ATTACHMENTS = originalLimit;
      }
    });

    it('should reject malformed attachment (missing data field)', async () => {
      const attachments: any[] = [
        {
          filename: 'receipt.png',
          mimeType: 'image/png',
          // missing data field
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /Malformed attachment/);
          return true;
        }
      );
    });
  });

  describe('Edge cases', () => {
    it('should return empty array for empty attachments array', async () => {
      const result = await processAttachments([]);
      assert.deepStrictEqual(result, []);
    });

    it('should reject empty file content', async () => {
      const attachments: Attachment[] = [
        {
          filename: 'empty.png',
          mimeType: 'image/png',
          data: '', // Empty base64 decodes to empty buffer
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /is empty/);
          return true;
        }
      );
    });

    it('should reject when total images exceed BOOKKEEPING_MAX_IMAGES_PER_MESSAGE after PDF expansion', async () => {
      const originalLimit = process.env.BOOKKEEPING_MAX_IMAGES_PER_MESSAGE;
      const originalPdfPages = process.env.BOOKKEEPING_MAX_PDF_PAGES;

      process.env.BOOKKEEPING_MAX_IMAGES_PER_MESSAGE = '2'; // Allow max 2 images total
      process.env.BOOKKEEPING_MAX_PDF_PAGES = '5'; // PDF could expand to 5 pages

      const pdfData = loadFixture('receipt-multipage.pdf');
      const pngData = loadFixture('receipt.png');
      const attachments: Attachment[] = [
        {
          filename: 'receipt.png',
          mimeType: 'image/png',
          data: pngData,
        },
        {
          filename: 'receipt-multipage.pdf',
          mimeType: 'application/pdf',
          data: pdfData,
        },
      ];

      await assert.rejects(
        () => processAttachments(attachments),
        (err: any) => {
          assert.ok(err instanceof AttachmentError);
          assert.match(err.message, /Too many images after processing/);
          return true;
        }
      );

      // Restore original limits
      if (originalLimit === undefined) {
        delete process.env.BOOKKEEPING_MAX_IMAGES_PER_MESSAGE;
      } else {
        process.env.BOOKKEEPING_MAX_IMAGES_PER_MESSAGE = originalLimit;
      }
      if (originalPdfPages === undefined) {
        delete process.env.BOOKKEEPING_MAX_PDF_PAGES;
      } else {
        process.env.BOOKKEEPING_MAX_PDF_PAGES = originalPdfPages;
      }
    });
  });
});
