# Plan: Support PDF receipts/invoices in receipt_ocr (issue #12)

## Source
GitHub issue #12, "Support PDF receipts/invoices in receipt_ocr" (raised as a deferred follow-up in PR #8 / issue #3).

## Summary
Add PDF support to `read_receipt` by rasterizing the first page of a PDF to a PNG image using the new `pdf-to-img` dependency, then feeding it through the existing `resizeImage` → vision-extraction pipeline unchanged.

## Goal
`read_receipt` accepts `.pdf` files: it rasterizes page 1 to a PNG, resizes it via the existing `resizeImage` step, and returns it as image content exactly like a native image input — no changes to the vision-extraction flow, confidence gating, or `capture_receipt`. Multi-page PDFs are supported by extracting page 1 only, with a note in the response text if more pages exist. Non-PDF, non-image files still reject clearly. All existing tests pass and the previous "PDF rejected" test is replaced with a "PDF accepted" test.

## Affected files
- `package.json` — add `pdf-to-img` dependency (MIT, single dep on `pdfjs-dist`, no native compilation, Node 20+/24+ compatible).
- `.pi/extensions/receipt_ocr/capture.ts` — `loadReceiptImage`: replace the PDF-rejection branch with rasterization; add a `pageCount` signal so the caller can note multi-page PDFs.
- `.pi/extensions/receipt_ocr/index.ts` — `read_receipt` tool: update `description`, `parameters.path.description`, and `promptGuidelines` to drop "PDF not supported" language; surface a note in the returned text when the source PDF has more than 1 page.
- `.pi/extensions/receipt_ocr/EXTENSION.md` — update the "Image only, no PDF" limitation section to describe PDF support (first page only) and the new dependency.
- `test/receipt_ocr.test.ts` — replace the "reject .pdf files" test with a "rasterize and accept .pdf files" test (using a real minimal single-page PDF fixture) and add a case for a multi-page PDF fixture asserting the page-count note.
- `test/fixtures/` — add `receipt.pdf` (single page) and `receipt-multipage.pdf` (2+ pages) fixtures.
- `AGENTS.md` — update the `read_receipt` line that says "PDF..." to reflect support.
- `BRAIN.md` — update the "Not supported (v1): PDF..." section.
- `README.md` — update the PDF-related mentions (supported formats list, extension summary line, issue changelog entry) to reflect PDF support.

## Implementation steps
1. Run `npm install pdf-to-img` (adds `pdf-to-img` + transitively `pdfjs-dist` to `package.json`/lockfile).
2. In `capture.ts`:
   - Detect `ext === '.pdf'` and branch into a new `rasterizePdf(fileBuffer)` helper using `pdf-to-img`'s `pdf()` API to get page 1 as a PNG buffer, plus the document's total page count.
   - Feed the rasterized PNG buffer into the existing `resizeImage` call exactly as image files do (mimeType `'image/png'`).
   - Extend `loadReceiptImage`'s return type to `{ data, mimeType, pageCount? }` (only set for PDFs) so `index.ts` can build the multi-page note without re-parsing the file.
   - Wrap rasterization in try/catch and rethrow a clean error message (consistent with the existing "Failed to read receipt file" pattern) for corrupted/password-protected PDFs.
   - Keep the "unsupported extension" rejection for all non-image, non-PDF formats unchanged.
3. In `index.ts` (`read_receipt` tool):
   - Update `parameters.path.description` and `promptGuidelines` to state PDF is supported (first page only).
   - When `loadReceiptImage` returns `pageCount > 1`, append a text note to the extraction prompt stating how many pages the PDF has and that only page 1 was extracted.
4. Update `EXTENSION.md`, `AGENTS.md`, `BRAIN.md`, `README.md` to remove "PDF not supported" language and describe the new first-page-only PDF support and the `pdf-to-img` dependency.
5. Add PDF test fixtures (`test/fixtures/receipt.pdf`, `test/fixtures/receipt-multipage.pdf`) — minimal valid hand-built PDF byte content, checked into the repo alongside the existing `receipt.png` fixture. Prefer hand-rolled minimal PDF bytes over adding a PDF-writing dev dependency.
6. Update `test/receipt_ocr.test.ts`:
   - Remove/replace the "should reject .pdf files" test with "should rasterize a single-page PDF and return valid PNG data".
   - Add "should note additional pages when given a multi-page PDF".
   - Keep the "reject unsupported extensions (e.g. .txt)" test unchanged.
7. Run `npm test` and `npx tsc --noEmit -p tsconfig.json`; fix any fallout.
8. Check `git status` to confirm no accidental writes to `memory/anomaly_log.json` or `memory/vendor_rules.json`.

## Tests to write
- `loadReceiptImage` on a single-page PDF fixture returns valid PNG data (magic bytes) with `mimeType: 'image/png'`.
- `loadReceiptImage` on a multi-page PDF fixture returns page 1's image plus `pageCount > 1`.
- Corrupted/garbage-bytes `.pdf` input throws a clear error (not a raw stack trace).
- Existing "unsupported extension" and "file not found" tests continue to pass unchanged.

## Risks and gotchas
- `pdf-to-img` depends on `pdfjs-dist`, which can be sensitive to Node version / WASM availability — verify it works cleanly under this repo's Node 24+ / `tsx` test runner before finishing.
- Corrupted or password-protected PDFs must fail with a clear error, not a stack trace.
- Building valid minimal PDF fixtures (esp. multi-page) by hand is fiddly; keep them as small, hand-rolled byte content rather than adding another dependency just for tests.
- `resizeImage` (from `@earendil-works/pi-coding-agent`) must accept a PNG buffer the same way it does for image files — confirm no PDF-specific quirks (e.g. color space from pdfjs rendering) break it.
- Keep the auto-post/confidence/duplicate hard rules untouched — this change only affects the input-loading step, not posting behavior.

## Out of scope
- Extracting/selecting a specific page number via a new tool parameter (deferred; first-page-only per this plan, confirmed with user).
- OCR/text-extraction-based PDF parsing (explicitly ruled out by the issue; vision-based extraction stays unchanged).
- Moving/copying the original PDF file into `data/processed/`.
- Structured line-item modeling (pre-existing deferred item, unrelated to this issue).
