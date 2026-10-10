---
name: pdf
description: "Use this skill to read PDF files: get their text (OCR for scanned pages, English), make a searchable copy of a scanned PDF, or ingest a PDF into a Qdrant collection. Triggers: a PDF to read, summarize, search or file away; a scan or photo-to-PDF with no selectable text; 'add this PDF to the library'."
---

# PDF — text, OCR and ingest

Everything runs inside this container: nothing is uploaded anywhere.
Text comes from the PDF's own text layer when it has one (instant). Pages
without text are scans: those are OCR'd with Tesseract (English only) via
OCRmyPDF, at low CPU priority. Expect roughly 1–3 seconds per scanned
page; text pages cost nothing.

## Quick use (shell)

```bash
python3 /opt/skills/pdf/pdf.py info FILE.pdf                     # pages, which have text
python3 /opt/skills/pdf/pdf.py text FILE.pdf --out /tmp/file.txt # text, OCR where needed
python3 /opt/skills/pdf/pdf.py text FILE.pdf                     # print the text instead
python3 /opt/skills/pdf/pdf.py ocr SCAN.pdf SCAN-searchable.pdf  # searchable copy
python3 /opt/skills/pdf/pdf.py ingest FILE.pdf COLLECTION        # into Qdrant
```

- The text (printed or in `--out`) has a `--- page N ---` line before each
  page, so you can tell which page a passage is on.
- `text` with `--out` prints a short JSON summary: `pages`, `ocr_pages`
  (pages that were OCR'd), `empty_pages` (still no text: blank pages or
  images without words), `chars`, `seconds`. Prefer `--out` for anything
  longer than a few pages, then read the parts you need.
- `--ocr never` skips OCR (text layer only), `--ocr force` OCRs every page
  (use it when the text layer is garbage, e.g. a bad earlier OCR).
- `ocr` keeps pages that already have text untouched; `--force` redoes all.
- `--notify` sends an ntfy message when the job ends (if ntfy is set up).
- Exit status 0 ok, 1 failed (message on stderr), 2 bad arguments.

## Ingest into Qdrant

```bash
python3 /opt/skills/pdf/pdf.py ingest FILE.pdf COLLECTION [--source NAME] [--replace] [--create]
```

Extracts the text (OCR as needed), splits it page by page into ~1500
character chunks with 200 characters of overlap, embeds them with the
collection's recorded model (see the qdrant skill) and upserts them.
Payload per point: `text`, `source` (default: the file name), `path`,
`page`, `chunk`, `ocr`, `ingested_at`.

- Re-ingesting the same `source` overwrites its points (stable ids).
  Use `--replace` when the document changed: it first deletes every point
  of that source, so no stale chunks remain.
- `--create` makes a missing collection with the Memory Embeddings model.
  Without it, a missing collection is an error (no silent new collections).

## Python

```python
import sys; sys.path.insert(0, '/opt/skills/pdf')
import pdf

pdf.info(path)                          # dict: pages, text_pages, pages_without_text, metadata
r = pdf.extract(path)                   # ocr='auto' | 'force' | 'never'
r['text'], r['page_texts'], r['ocr_pages'], r['empty_pages']
pdf.paged_text(r)                       # text with '--- page N ---' markers
pdf.chunks(r)                           # [{'text', 'page', 'chunk'}] for your own embedding
pdf.ocr(path, out_path, force=False)    # searchable PDF
pdf.ingest(path, 'collection', source=None, replace=False, create=False, extra_payload=None)
```

Errors raise `pdf.PdfError` with a message you can pass on.

## Files from the NAS or the webchat

Copy the file somewhere local first, then run the helper on the copy:

```python
import sys; sys.path.insert(0, '/opt/skills/nas')
import nas
open('/tmp/in.pdf', 'wb').write(nas.read_bytes('Docs', 'scans/letter.pdf'))
```

Write results back with `nas.write_bytes` or hand them to the webchat user
with the webchat-present skill.

## Big scanned documents

More than ~30 scanned pages can take minutes. Run it in the background
and check the summary file rather than waiting on one long command:

```bash
nohup python3 /opt/skills/pdf/pdf.py text /tmp/big.pdf --out /tmp/big.txt --notify > /tmp/big.log 2>&1 &
cat /tmp/big.log    # the JSON summary appears when it is done
```

## Limits

- English OCR only. Other languages come out as rough Latin-letter text.
- Password-protected PDFs are refused: ask for an unprotected copy.
- Handwriting and very low resolution scans OCR poorly; say so when the
  text looks garbled instead of guessing.
- Tables come out as text in reading order, not as structured cells.
