"""Crawl4AI helper for OpenClaw skills: fetch pages as clean Markdown.

Usage from Python:
    import sys; sys.path.insert(0, '/opt/skills/crawl4ai')
    import crawl4ai
    page = crawl4ai.fetch('https://example.com/article')
    page['title'], page['markdown'], page['status'], page['final_url']
    pages = crawl4ai.fetch_many(['https://a.example', 'https://b.example'])

From a shell (prints title, URL and Markdown, cut to --max characters):
    python3 /opt/skills/crawl4ai/crawl4ai.py URL [--max 20000] [--out FILE] [--fresh]

Crawl4AI's raw /crawl response is large (tens of KB of HTML and metadata per
page); this helper returns only what an agent needs.
"""

import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, '/opt/skills/rbw')
from creds import CredentialError, auth_headers, not_configured, use_gateway_env  # noqa: E402


class CrawlError(RuntimeError):
    pass


def _base():
    use_gateway_env('CRAWL4AI_URL')
    base = os.environ.get('CRAWL4AI_URL', '').strip().rstrip('/')
    if not base:
        raise CrawlError(not_configured('CRAWL4AI_URL', 'Crawl4AI'))
    return base


def _markdown_of(result):
    md = result.get('markdown')
    if isinstance(md, str):  # older Crawl4AI versions
        return md
    if isinstance(md, dict):
        return md.get('fit_markdown') or md.get('raw_markdown') or ''
    return ''


def _page(result):
    meta = result.get('metadata') or {}
    ok = bool(result.get('success'))
    return {
        'url': result.get('url'),
        'final_url': result.get('redirected_url') or result.get('url'),
        'status': result.get('status_code'),
        'success': ok,
        'error': None if ok else (result.get('error_message') or 'crawl failed'),
        'title': meta.get('title') or '',
        'markdown': _markdown_of(result) if ok else '',
    }


def fetch_many(urls, fresh=False, timeout=180):
    """Crawl several URLs in one request; returns a list of page dicts."""
    base = _base()
    body = {'urls': list(urls)}
    if fresh:
        body['crawler_config'] = {'type': 'CrawlerRunConfig', 'params': {'cache_mode': 'bypass'}}
    try:
        hdrs = auth_headers('Authorization', 'CRAWL4AI_KEY', prefix='Bearer ')
    except CredentialError as e:
        raise CrawlError(str(e)) from None
    hdrs['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        f'{base}/crawl', data=json.dumps(body).encode(), headers=hdrs, method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise CrawlError('Crawl4AI refused the token (401). Check the API token in Configure External Services / Vaultwarden.') from None
        detail = e.read()[:300].decode('utf-8', 'replace')
        raise CrawlError(f'Crawl4AI returned HTTP {e.code}: {detail}') from None
    except urllib.error.URLError as e:
        raise CrawlError(f'Cannot reach Crawl4AI at {base}: {e.reason}') from None
    results = data.get('results')
    if results is None and 'url' in data:  # single-result shape
        results = [data]
    if not results:
        raise CrawlError('Crawl4AI returned no results' + (f": {data.get('error')}" if data.get('error') else ''))
    return [_page(r) for r in results]


def fetch(url, fresh=False, timeout=180):
    """Crawl one URL; returns a page dict (check page['success'])."""
    return fetch_many([url], fresh=fresh, timeout=timeout)[0]


def _main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='Fetch a page through Crawl4AI as Markdown.')
    ap.add_argument('url')
    ap.add_argument('--max', type=int, default=20000, help='max characters to print (0 = all)')
    ap.add_argument('--out', help='also write the full Markdown to this file')
    ap.add_argument('--fresh', action='store_true', help="bypass Crawl4AI's cache")
    a = ap.parse_args(argv)
    try:
        page = fetch(a.url, fresh=a.fresh)
    except CrawlError as e:
        print(f'Crawl4AI error: {e}', file=sys.stderr)
        return 1
    if not page['success']:
        print(f"Crawl failed for {a.url} (HTTP {page['status']}): {page['error']}", file=sys.stderr)
        return 2
    md = page['markdown']
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(md)
    print(f"# {page['title']}\n<{page['final_url']}> (HTTP {page['status']}, {len(md)} chars)\n")
    if a.max and len(md) > a.max:
        print(md[:a.max])
        print(f"\n[... cut at {a.max} of {len(md)} characters" + (f"; full text in {a.out}" if a.out else '; use --out FILE for all of it') + ']')
    else:
        print(md)
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
