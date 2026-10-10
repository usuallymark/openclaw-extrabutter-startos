---
name: searxng
description: "Use this skill to search the web via SearXNG. Triggers: any time you need current information from the web, need to research a topic, or need to verify recent facts."
---

# SearXNG — Web Search

## Purpose

SearXNG is a privacy-respecting metasearch engine. Use it to search the
web without tracking, rate limits, or API costs. Results aggregate from
multiple search engines.

## Connection

```python
import os
SEARXNG_URL = os.environ.get('SEARXNG_URL')

if not SEARXNG_URL:
    raise RuntimeError('SearXNG is not configured. Enable it in Configure External Services.')
```

## Search

```python
import json, urllib.request, urllib.parse, os

SEARXNG_URL = os.environ['SEARXNG_URL']

def search(query, num_results=10, language='en', time_range=None):
    params = {
        'q': query,
        'format': 'json',
        'language': language,
        'pageno': 1,
    }
    if time_range:  # 'day', 'week', 'month', 'year'
        params['time_range'] = time_range

    url = f'{SEARXNG_URL}/search?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={'Accept': 'application/json'}
    )
    resp = urllib.request.urlopen(req, timeout=15)
    data = json.loads(resp.read())

    results = []
    for r in data.get('results', [])[:num_results]:
        results.append({
            'title': r.get('title'),
            'url': r.get('url'),
            'snippet': r.get('content'),
        })
    return results

# Example
results = search('latest developments in AI 2026', num_results=5)
for r in results:
    print(f"- {r['title']}: {r['url']}")
    print(f"  {r['snippet']}")
```

## Notes

- No authentication required
- Set `time_range` to `'week'` or `'month'` for recent results
- SearXNG must have JSON format enabled in its settings
- Respect rate limits — avoid running many searches in rapid succession
