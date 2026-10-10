"""PDF text extraction, OCR and Qdrant ingest for OpenClaw skills.

Python:
    import sys; sys.path.insert(0, '/opt/skills/pdf')
    import pdf
    pdf.info('/data/inbox/report.pdf')         # pages, which pages have text
    r = pdf.extract('/data/inbox/scan.pdf')    # OCRs only pages without text
    r['text'], r['page_texts'], r['ocr_pages']
    pdf.paged_text(r)                          # text with '--- page N ---' markers
    pdf.ocr('/data/inbox/scan.pdf', '/data/inbox/scan-searchable.pdf')
    pdf.chunks(r)                              # [{'text', 'page', 'chunk'}] for embedding
    pdf.ingest('/data/inbox/scan.pdf', 'my-collection')

CLI:
    python3 /opt/skills/pdf/pdf.py info FILE
    python3 /opt/skills/pdf/pdf.py text FILE [--out TEXT_FILE] [--ocr auto|force|never] [--json]
    python3 /opt/skills/pdf/pdf.py ocr FILE OUT.pdf [--force]
    python3 /opt/skills/pdf/pdf.py ingest FILE COLLECTION [--source NAME] [--replace] [--create]
Common options: --lang eng, --jobs 2, --notify (ntfy message when done).

Text comes from the PDF's own text layer (pypdfium2, instant). Pages with
(almost) no text are scanned images: those are OCR'd with OCRmyPDF +
Tesseract (English), at low CPU priority. Exit status: 0 ok, 1 failed,
2 bad arguments.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

for _p in ('/opt/python-libs',):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pypdfium2 as pdfium  # noqa: E402

MIN_CHARS = 25        # a page with fewer characters of text is treated as a scan
DEFAULT_JOBS = 2      # OCR worker processes; keeps the gateway responsive
DEFAULT_LANG = 'eng'  # the image ships English only
CHUNK_SIZE = 1500     # characters per chunk for embedding
CHUNK_OVERLAP = 200
_NS = uuid.UUID('5b0f8a52-3c2e-4d7e-9a51-6f1c2d0e8b47')  # for stable point ids


class PdfError(RuntimeError):
    pass


# ── reading ───────────────────────────────────────────────────────────────

def _open(path):
    if not os.path.isfile(path):
        raise PdfError(f'No such file: {path}')
    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as e:
        msg = str(e)
        if 'password' in msg.lower():
            raise PdfError(f'{path} is password-protected; ask for an unprotected copy.') from None
        raise PdfError(f'Cannot read {path} as a PDF: {msg}') from None


def _page_texts(path):
    doc = _open(path)
    try:
        out = []
        for i in range(len(doc)):
            page = doc[i]
            tp = page.get_textpage()
            try:
                out.append(tp.get_text_range().replace('\r\n', '\n').replace('\r', '\n'))
            finally:
                tp.close()
                page.close()
        return out
    finally:
        doc.close()


def _needs_ocr(texts):
    return [i + 1 for i, t in enumerate(texts) if len(t.strip()) < MIN_CHARS]


def info(path):
    """Page count, metadata, and which pages have a text layer."""
    doc = _open(path)
    try:
        meta = {k: v for k, v in (doc.get_metadata_dict() or {}).items() if v}
        n = len(doc)
    finally:
        doc.close()
    texts = _page_texts(path)
    scans = _needs_ocr(texts)
    return {
        'file': path,
        'pages': n,
        'bytes': os.path.getsize(path),
        'text_pages': n - len(scans),
        'pages_without_text': scans,
        'chars': sum(len(t.strip()) for t in texts),
        'metadata': meta,
    }


# ── OCR ───────────────────────────────────────────────────────────────────

def _run_ocrmypdf(src, dst, mode, pages=None, lang=DEFAULT_LANG, jobs=DEFAULT_JOBS, timeout=None):
    cmd = [sys.executable, '-m', 'ocrmypdf', '--quiet',
           '--output-type', 'pdf',      # plain PDF: no Ghostscript needed
           '--rasterizer', 'pypdfium',
           '--rotate-pages',
           '-l', lang, '--jobs', str(max(1, int(jobs)))]
    cmd.append('--force-ocr' if mode == 'force' else '--skip-text')
    if pages:
        cmd += ['--pages', ','.join(str(p) for p in pages)]
    cmd += [src, dst]
    if shutil.which('nice'):
        cmd = ['nice', '-n', '10'] + cmd
    env = {**os.environ, 'OMP_THREAD_LIMIT': '1'}
    env['PYTHONPATH'] = os.pathsep.join(p for p in ('/opt/python-libs', env.get('PYTHONPATH', '')) if p)
    try:
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise PdfError(f'OCR took longer than {timeout} s; run it in the background (see the pdf skill).') from None
    if r.returncode != 0 or not os.path.exists(dst):
        lines = [ln for ln in (r.stderr or r.stdout).strip().splitlines() if ln.strip()]
        detail = ' | '.join(lines[-3:]) or f'exit {r.returncode}'
        raise PdfError(f'OCR failed: {detail}')


def ocr(path, out_path, force=False, lang=DEFAULT_LANG, jobs=DEFAULT_JOBS, timeout=None):
    """Write a searchable copy of the PDF. Pages that already have text are kept
    as they are, unless force=True (then every page is rasterized and OCR'd)."""
    _open(path).close()
    out_dir = os.path.dirname(os.path.abspath(out_path)) or '.'
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix='.pdf', dir=out_dir, prefix='.ocr-')
    os.close(fd)
    try:
        _run_ocrmypdf(path, tmp, 'force' if force else 'skip', lang=lang, jobs=jobs, timeout=timeout)
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    _give_to_node(out_path)
    texts = _page_texts(out_path)
    return {'file': out_path, 'pages': len(texts), 'pages_without_text': _needs_ocr(texts)}


def extract(path, ocr='auto', lang=DEFAULT_LANG, jobs=DEFAULT_JOBS, timeout=None):
    """Text of every page. ocr='auto' OCRs only pages without a text layer,
    'force' OCRs every page, 'never' returns the text layer only."""
    if ocr not in ('auto', 'force', 'never'):
        raise PdfError("ocr must be 'auto', 'force' or 'never'")
    start = time.monotonic()
    texts = _page_texts(path)
    todo = list(range(1, len(texts) + 1)) if ocr == 'force' else _needs_ocr(texts)
    done = []
    if ocr != 'never' and todo:
        with tempfile.TemporaryDirectory(prefix='pdf-ocr-') as d:
            out = os.path.join(d, 'ocr.pdf')
            # Rasterize just the pages without text; other pages are not touched.
            _run_ocrmypdf(path, out, 'force', pages=todo, lang=lang, jobs=jobs, timeout=timeout)
            ocr_texts = _page_texts(out)
        for p in todo:
            if p <= len(ocr_texts):
                texts[p - 1] = ocr_texts[p - 1]
                done.append(p)
    empty = _needs_ocr(texts)
    return {
        'file': path,
        'pages': len(texts),
        'ocr_pages': done,
        'empty_pages': empty,
        'chars': sum(len(t.strip()) for t in texts),
        'seconds': round(time.monotonic() - start, 1),
        'page_texts': texts,
        'text': '\n\n'.join(t.strip() for t in texts if t.strip()),
    }


def paged_text(result):
    """The text with a '--- page N ---' line before each page (empty pages
    included), so a reader can tell which page a passage is on."""
    return '\n\n'.join(f'--- page {n} ---\n{t.strip()}'
                        for n, t in enumerate(result['page_texts'], start=1)).rstrip()


# ── chunking + ingest ─────────────────────────────────────────────────────

def _split(text, size, overlap):
    text = ' '.join(text.split())
    if len(text) <= size:
        return [text] if text else []
    parts, start = [], 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            cut = text.rfind(' ', start + size // 2, end)
            end = cut if cut > start else end
        parts.append(text[start:end].strip())
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
        sp = text.find(' ', start)
        start = sp + 1 if 0 <= sp < end else start
    return [p for p in parts if p]


def chunks(result, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split an extract() result into [{'text', 'page', 'chunk'}], page by page."""
    out = []
    for n, t in enumerate(result['page_texts'], start=1):
        for i, piece in enumerate(_split(t, size, overlap)):
            out.append({'text': piece, 'page': n, 'chunk': i})
    return out


def ingest(path, collection, source=None, replace=False, create=False, ocr='auto',
           lang=DEFAULT_LANG, jobs=DEFAULT_JOBS, batch=32, extra_payload=None):
    """Extract, chunk and upsert a PDF into a Qdrant collection.

    Payload per point: text, source, path, page, chunk, ocr, ingested_at (+extra).
    Point ids are derived from (source, page, chunk), so ingesting the same
    source again overwrites instead of duplicating; replace=True first deletes
    every point of that source (use it when the document changed)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'qdrant'))
    import qdrant
    import urllib.parse

    source = source or os.path.basename(path)
    if collection not in {c["name"] for c in qdrant.collections()}:
        if not create:
            raise PdfError(f'Collection "{collection}" does not exist. Add --create (create=True) to make it '
                           'with the Memory Embeddings model, or pick an existing collection.')
        qdrant.create(collection)
    else:
        qdrant.model_of(collection)  # fails early, with the fix, if the model is unknown
    r = extract(path, ocr=ocr, lang=lang, jobs=jobs)
    pieces = chunks(r)
    if not pieces:
        raise PdfError(f'No text found in {path} (pages without text: {r["empty_pages"]}).')
    if replace:
        qdrant._q('POST', f'/collections/{urllib.parse.quote(collection)}/points/delete?wait=true',
                  {'filter': {'must': [{'key': 'source', 'match': {'value': source}}]}})
    stamp = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    ocr_pages = set(r['ocr_pages'])
    points = []
    for c in pieces:
        payload = {'source': source, 'path': os.path.abspath(path), 'page': c['page'],
                   'chunk': c['chunk'], 'ocr': c['page'] in ocr_pages, 'ingested_at': stamp}
        payload.update(extra_payload or {})
        pid = str(uuid.uuid5(_NS, f'{source}\0{c["page"]}\0{c["chunk"]}'))
        points.append({'id': pid, 'text': c['text'], 'payload': payload})
    for i in range(0, len(points), batch):
        qdrant.upsert(collection, points[i:i + batch])
    return {'file': path, 'collection': collection, 'source': source, 'pages': r['pages'],
            'ocr_pages': r['ocr_pages'], 'empty_pages': r['empty_pages'], 'points': len(points),
            'seconds': r['seconds']}


# ── helpers ───────────────────────────────────────────────────────────────

def _give_to_node(path):
    """Files written by root (debug shells) are handed to the gateway user."""
    if os.geteuid() == 0 and os.path.abspath(path).startswith('/data/'):
        try:
            shutil.chown(path, 'node', 'node')
        except (LookupError, OSError):
            pass


def _notify(message, ok=True):
    if shutil.which('notify'):
        subprocess.run(['notify', '--title', 'PDF ' + ('done' if ok else 'failed'), '--', message],
                       capture_output=True, timeout=30)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='pdf.py', description='PDF text, OCR and ingest.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--lang', default=DEFAULT_LANG)
    common.add_argument('--jobs', type=int, default=DEFAULT_JOBS)
    common.add_argument('--notify', action='store_true', help='send an ntfy message when finished')

    p = sub.add_parser('info', help='pages and which have text')
    p.add_argument('file')
    p = sub.add_parser('text', parents=[common], help='extract text (OCR where needed)')
    p.add_argument('file')
    p.add_argument('--out', help='write the text here instead of printing it')
    p.add_argument('--ocr', choices=('auto', 'force', 'never'), default='auto')
    p.add_argument('--json', action='store_true', help='print the full result as JSON')
    p = sub.add_parser('ocr', parents=[common], help='write a searchable copy of the PDF')
    p.add_argument('file')
    p.add_argument('out')
    p.add_argument('--force', action='store_true', help='OCR every page, even pages with text')
    p = sub.add_parser('ingest', parents=[common], help='extract, chunk and upsert into Qdrant')
    p.add_argument('file')
    p.add_argument('collection')
    p.add_argument('--source', help='name stored in the payload (default: file name)')
    p.add_argument('--replace', action='store_true', help='delete earlier points of this source first')
    p.add_argument('--create', action='store_true', help='create the collection if missing')
    p.add_argument('--ocr', choices=('auto', 'force', 'never'), default='auto')
    a = ap.parse_args(argv)

    label = os.path.basename(getattr(a, 'file', ''))
    try:
        if a.cmd == 'info':
            print(json.dumps(info(a.file), indent=2))
            return 0
        if a.cmd == 'text':
            r = extract(a.file, ocr=a.ocr, lang=a.lang, jobs=a.jobs)
            summary = {k: v for k, v in r.items() if k not in ('page_texts', 'text')}
            if a.out:
                os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
                with open(a.out, 'w') as f:
                    f.write(paged_text(r) + '\n')
                _give_to_node(a.out)
                summary['out'] = a.out
                print(json.dumps(summary, indent=2))
            elif a.json:
                print(json.dumps(r, indent=2))
            else:
                print(paged_text(r))
                print(json.dumps(summary), file=sys.stderr)
            msg = f'{label}: {r["pages"]} pages, OCR on {len(r["ocr_pages"])}'
        elif a.cmd == 'ocr':
            r = ocr(a.file, a.out, force=a.force, lang=a.lang, jobs=a.jobs)
            print(json.dumps(r, indent=2))
            msg = f'{label}: searchable copy written to {a.out}'
        else:
            r = ingest(a.file, a.collection, source=a.source, replace=a.replace, create=a.create,
                       ocr=a.ocr, lang=a.lang, jobs=a.jobs)
            print(json.dumps(r, indent=2))
            msg = f'{label}: {r["points"]} chunks into {a.collection}'
        if getattr(a, 'notify', False):
            _notify(msg)
        return 0
    except Exception as e:  # report every failure the same way
        err = f'{e.__class__.__name__ if not isinstance(e, PdfError) else "pdf"}: {e}'
        print(err, file=sys.stderr)
        if getattr(a, 'notify', False):
            _notify(f'{label}: {e}', ok=False)
        return 1


if __name__ == '__main__':
    sys.exit(main())
