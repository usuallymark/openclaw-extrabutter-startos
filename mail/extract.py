"""Text out of an attachment, without handing the file to anyone.

Supported: text/* (HTML through the same hidden-text filter as mail
bodies), PDF (pypdfium2, from the image), Word .docx (its XML text), and
attached messages. Everything else: "no text extraction for this type".
Inputs are hostile: page, size and expansion limits apply throughout.
"""

import io
import re
import sys
import zipfile

from sanitize import clean_text, html_to_text

PDF_PAGES = 40
DOCX_XML_LIMIT = 8 * 1024 * 1024


def _pdf_text(data):
    if '/opt/python-libs' not in sys.path:
        sys.path.append('/opt/python-libs')
    import pypdfium2 as pdfium  # noqa: E402

    pdf = pdfium.PdfDocument(data)
    try:
        n = len(pdf)
        out = []
        for i in range(min(n, PDF_PAGES)):
            page = pdf[i]
            tp = page.get_textpage()
            out.append(tp.get_text_range())
            tp.close()
            page.close()
        text = '\n\n'.join(out)
        if n > PDF_PAGES:
            text += f'\n[… only the first {PDF_PAGES} of {n} pages are read]'
        if not text.strip():
            text = '[the PDF has no text layer (a scan); no text can be read here]'
        return text
    finally:
        pdf.close()


def _docx_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        info = z.getinfo('word/document.xml')
        if info.file_size > DOCX_XML_LIMIT:
            return '[the document is too large to read here]'
        xml = z.read(info).decode('utf-8', 'replace')
    xml = re.sub(r'</w:p>', '\n', xml)
    xml = re.sub(r'<w:tab/>', '\t', xml)
    xml = re.sub(r'<[^>]+>', '', xml)
    for a, b in (('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'"), ('&amp;', '&')):
        xml = xml.replace(a, b)
    return xml


def attachment_text(part):
    """(text, note) for one attachment part."""
    ct = part.get_content_type()
    if ct == 'message/rfc822':
        from message import body_text, summary_headers  # noqa: E402
        inner = part.get_payload()
        inner = inner[0] if isinstance(inner, list) and inner else inner
        if inner is None or not hasattr(inner, 'walk'):
            return '', 'the attached message could not be read'
        h = summary_headers(inner)
        text, _ = body_text(inner)
        head = f'From: {h["from"].get("name")} <{h["from"].get("address")}>\nSubject: {h["subject"]}\nDate: {h["date"]}\n\n'
        return head + text, 'attached message'
    try:
        data = part.get_payload(decode=True) or b''
    except Exception:
        return '', 'the attachment could not be decoded'
    fname = (part.get_filename() or '').lower()
    try:
        if ct == 'text/html' or fname.endswith(('.html', '.htm')):
            text, hidden, _ = html_to_text(data.decode(part.get_content_charset() or 'utf-8', 'replace'))
            return text, f'HTML, {hidden} hidden characters removed' if hidden else 'HTML'
        if ct.startswith('text/') or ct in ('application/json', 'application/xml', 'application/csv') \
                or fname.endswith(('.txt', '.csv', '.md', '.json', '.ics', '.log', '.xml')):
            return clean_text(data.decode(part.get_content_charset() or 'utf-8', 'replace')), ct
        if ct == 'application/pdf' or fname.endswith('.pdf'):
            return clean_text(_pdf_text(data)), 'PDF'
        if fname.endswith('.docx') or ct == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return clean_text(_docx_text(data)), 'Word document'
    except Exception as e:  # hostile or broken file
        return '', f'text could not be extracted ({type(e).__name__})'
    return '', f'no text extraction for {ct}; the file stays in the mailbox'
