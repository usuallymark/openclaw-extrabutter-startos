---
name: crawl4ai
description: "Use this skill to get the readable content of web pages through the self-hosted Crawl4AI server, which renders pages in a real browser. Triggers: web_fetch returned little or no content, the page needs JavaScript, or a site blocked a plain fetch; also for fetching several pages at once."
---

# Crawl4AI — Web Pages as Markdown

## When to use it

1. For an ordinary article or documentation page, try the built-in
   `web_fetch` tool first: it is faster.
2. Use Crawl4AI when `web_fetch` comes back empty, truncated to a shell,
   blocked (403, "enable JavaScript", a bot check), or the page is built by
   JavaScript (shops, dashboards, single-page apps).
3. Use it to fetch several known URLs in one go.

Crawl4AI runs on the user's own server, so the pages you fetch stay
private. It cannot log in to sites, and some heavily protected sites will
still refuse it: say so rather than retrying in a loop.

## Quick use (shell)

```bash
python3 /opt/skills/crawl4ai/crawl4ai.py 'https://example.com/article'
python3 /opt/skills/crawl4ai/crawl4ai.py 'https://example.com/long' --max 8000 --out /tmp/long.md
python3 /opt/skills/crawl4ai/crawl4ai.py 'https://example.com/prices' --fresh   # skip the cache
```

Prints the title, final URL, HTTP status and the page as Markdown (cut to
`--max` characters, default 20000). A slow page can take up to a minute or
two.

## From Python

```python
import sys; sys.path.insert(0, '/opt/skills/crawl4ai')
import crawl4ai

page = crawl4ai.fetch('https://example.com/article')
if page['success']:
    print(page['title'], page['final_url'], len(page['markdown']))
else:
    print('failed:', page['status'], page['error'])

for p in crawl4ai.fetch_many(['https://a.example', 'https://b.example']):
    print(p['url'], p['success'], len(p['markdown']))
```

Each page is a dict: `url`, `final_url`, `status`, `success`, `error`,
`title`, `markdown`. Configuration, connection and token problems raise
`crawl4ai.CrawlError` with a readable message.

## Notes

- Do not call the `/crawl` endpoint yourself and print the response: it is
  tens of KB of HTML and metadata per page. Use the helper.
- The API token is handled by the helper (`getcred`); never print it.
- Respect copyright: summarise or quote briefly; do not store large verbatim
  copies of pages.
- Use `--fresh` / `fresh=True` when the page changes often (prices,
  availability); otherwise Crawl4AI may answer from its cache.
