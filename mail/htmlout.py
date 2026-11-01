"""Outgoing HTML mail (since 2026.10.1:21): check an HTML body written in
the workspace before it becomes part of a draft.

The HTML is written by the main agent, which reads outsiders' content; if
that agent were ever misled, HTML is the place to hide something from the
owner who approves the mail. So:

- Refused outright: scripts, event handlers, javascript: and other
  non-web link schemes, forms and their fields, frames, objects, embeds,
  <base>, <meta http-equiv>, <link> (outside style sheets), CSS @import.
- Images are embedded, never loaded from outside: <img src="name.png">
  names a file in mail-outbox, which the service attaches inline (cid:).
  An outside image address (http:, https:, //) is refused: opening the mail
  would fetch it, telling that server the mail was read and carrying
  whatever the address holds, and the picture could change after approval.
  The same for srcset, background= and url(...) in CSS (data: images are
  allowed; they are already inside the mail).
- Links (http, https, mailto) are allowed and listed with their domains.
- Hidden text (text a person would not see) is counted and searched for
  instructions to an AI, with the same checks as incoming mail.

describe() returns what Review Agent Actions shows.
"""

import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

from sanitize import hidden_flags, html_parts

MAX_HTML_BYTES = 1024 * 1024
IMAGE_TYPES = {'png': 'png', 'jpg': 'jpeg', 'jpeg': 'jpeg', 'gif': 'gif', 'webp': 'webp'}

_FORBIDDEN_TAGS = {'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form',
                   'input', 'button', 'textarea', 'select', 'option', 'base', 'link', 'portal'}
_URL_ATTRS = {'href', 'src', 'action', 'formaction', 'background', 'poster', 'data', 'cite',
              'longdesc', 'usemap', 'xlink:href'}
_CSS_URL = re.compile(r'url\(\s*([\'"]?)(.*?)\1\s*\)', re.I | re.S)
_FILE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,150}')


class HtmlRefused(Exception):
    """The HTML cannot be sent; the message says why."""


def _remote(url):
    u = url.strip().lower()
    return u.startswith(('http:', 'https:', '//', 'ftp:'))


def _image_name(url):
    """A file name in mail-outbox an <img> may point at, or None."""
    u = url.strip()
    if not _FILE_NAME.fullmatch(u) or '..' in u:
        return None
    ext = u.rsplit('.', 1)[-1].lower() if '.' in u else ''
    return u if ext in IMAGE_TYPES else None


class _Scan(HTMLParser):
    def __init__(self, allow_cid=False):
        super().__init__(convert_charrefs=True)
        self.allow_cid = allow_cid
        self.problems = []
        self.links = []
        self.images = []
        self.in_style = False

    def _problem(self, text):
        if text not in self.problems:
            self.problems.append(text)

    def _css(self, css, where):
        if re.search(r'@import', css, re.I):
            self._problem(f'CSS @import in {where} (loads a style sheet from outside)')
        if re.search(r'expression\s*\(|behavior\s*:|-moz-binding', css, re.I):
            self._problem(f'active CSS (expression/behavior/binding) in {where}')
        for _, url in _CSS_URL.findall(css):
            u = url.strip()
            if u.lower().startswith('data:image/'):
                continue
            if _remote(u):
                self._problem(f'an outside image in CSS ({u[:80]}): embed the image instead')
            else:
                self._problem(f'url({u[:60]}) in CSS: only data: images are allowed there; '
                              'put pictures in <img src="file.png">')

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in _FORBIDDEN_TAGS:
            self._problem(f'<{tag}> is not allowed in outgoing mail')
        if tag == 'meta' and any(k.lower() == 'http-equiv' for k, _ in attrs):
            self._problem('<meta http-equiv> is not allowed in outgoing mail')
        if tag == 'style':
            self.in_style = True
        for k, v in attrs:
            k, v = k.lower(), v or ''
            if k.startswith('on'):
                self._problem(f'the event handler {k}= is not allowed (it would be a script)')
                continue
            if k == 'style':
                self._css(v, f'<{tag} style>')
                continue
            if k == 'srcset':
                self._problem('srcset is not allowed: use one embedded image in src')
                continue
            if k not in _URL_ATTRS:
                continue
            u = v.strip()
            low = u.lower()
            if (tag == 'img' and k == 'src') or k == 'background':
                if low.startswith('data:image/'):
                    continue
                if low.startswith('cid:'):
                    if self.allow_cid:
                        if u[4:] not in self.images:
                            self.images.append(u[4:])
                    else:
                        self._problem('cid: images cannot be given directly: name the file in mail-outbox')
                    continue
                if _remote(u):
                    self._problem(f'an outside image ({u[:80]}): put the file in mail-outbox and use '
                                  'its name, so it is embedded in the mail')
                    continue
                name = _image_name(u)
                if not name:
                    self._problem(f'image "{u[:60]}": must be a .png, .jpg, .gif or .webp file name '
                                  'directly in mail-outbox')
                    continue
                if name not in self.images:
                    self.images.append(name)
                continue
            if k == 'href' and tag == 'a':
                if not u or u.startswith('#'):
                    continue
                if low.startswith(('http:', 'https:', 'mailto:')):
                    self.links.append(u)
                    continue
                self._problem(f'a link to "{u[:60]}": only http, https and mailto links are allowed')
                continue
            if u and not u.startswith('#'):
                self._problem(f'{k}= on <{tag}> pointing at "{u[:60]}" is not allowed')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() == 'style':
            self.in_style = False

    def handle_endtag(self, tag):
        if tag.lower() == 'style':
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self._css(data, '<style>')


def _domain(url):
    if url.lower().startswith('mailto:'):
        return 'mailto:' + url[7:].split('?')[0].split('@')[-1].lower()
    try:
        return (urlsplit(url).hostname or '?').lower()
    except ValueError:
        return '?'


def check(html, allow_cid=False):
    """Scan HTML. Returns a dict: images (file names to embed), links,
    domains, text (the visible text, for a plain-text version), hidden_chars,
    flags. Raises HtmlRefused listing every problem. allow_cid: the HTML of
    a finished draft (its images already embedded), for describe()."""
    if len(html.encode('utf-8', 'replace')) > MAX_HTML_BYTES:
        raise HtmlRefused(f'the HTML is larger than {MAX_HTML_BYTES // 1024} KB')
    s = _Scan(allow_cid)
    try:
        s.feed(html)
        s.close()
    except Exception as e:  # noqa: BLE001
        raise HtmlRefused(f'the HTML could not be read ({type(e).__name__})') from None
    if s.problems:
        raise HtmlRefused('; '.join(s.problems[:8]) + (' …' if len(s.problems) > 8 else ''))
    text, hidden, _, hidden_text = html_parts(html)
    domains = []
    for u in s.links:
        d = _domain(u)
        if d not in domains:
            domains.append(d)
    return {'images': s.images, 'links': s.links, 'domains': domains, 'text': text,
            'hidden_chars': hidden, 'flags': hidden_flags(hidden, hidden_text)}


def embed(html, cids):
    """Point each embedded image at its cid: {file name: cid without <>}."""
    for name, cid in cids.items():
        html = re.sub(r'(\b(?:src|background)\s*=\s*)(["\']?)' + re.escape(name) + r'\2(?=[\s>/])',
                      lambda m: f'{m.group(1)}"cid:{cid}"', html, flags=re.I)
    return html


def describe(info, html_bytes):
    """Lines for Review Agent Actions."""
    lines = [f'HTML: {round(html_bytes / 1024, 1)} KB, '
             f'{len(info["links"])} link(s), {len(info["images"])} embedded image(s)']
    if info['domains']:
        lines.append('Links go to: ' + ', '.join(info['domains'][:15])
                     + (f' (+{len(info["domains"]) - 15} more)' if len(info['domains']) > 15 else ''))
    if info['images']:
        lines.append('Embedded images: ' + ', '.join(info['images'][:10]))
    if 'hidden_injection' in info['flags']:
        lines.append(f'WARNING: {info["hidden_chars"]} characters of hidden text (a person would not see '
                     'them), and they try to instruct an AI. Reject unless you know why.')
    elif info['hidden_chars']:
        lines.append(f'Note: {info["hidden_chars"]} characters of hidden text (a person would not see them).')
    return lines
