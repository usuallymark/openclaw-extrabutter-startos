#!/usr/bin/env python3
"""Qdrant helper for OpenClaw: collections that remember their embedding model.

Every collection is tied to the embedding model its vectors were made with.
Vectors from another model are useless there (a different size is rejected by
Qdrant; the same size silently returns nonsense). This helper records each
collection's model in /data/.openclaw/qdrant-models.json, embeds text with that
model, and refuses vectors of the wrong size.

From Python:
    import sys; sys.path.insert(0, '/opt/skills/qdrant')
    import qdrant
    qdrant.collections()                          # [{'name','size','points','model'}, ...]
    qdrant.search('notes', 'what did we decide about backups?', limit=5)
    qdrant.upsert('notes', [{'text': 'Backups run nightly', 'payload': {'source': 'chat'}}])
    qdrant.create('new-notes')                    # uses the Memory Embeddings model
    qdrant.set_model('old-notes', 'ollama', 'nomic-embed-text')   # record an existing one

From a shell:
    python3 /opt/skills/qdrant/qdrant.py list
    python3 /opt/skills/qdrant/qdrant.py search COLLECTION "query" [--limit N]
    python3 /opt/skills/qdrant/qdrant.py set-model COLLECTION PROVIDER MODEL
    python3 /opt/skills/qdrant/qdrant.py create COLLECTION [PROVIDER MODEL]

Providers: ollama, openai, gemini. Exit status 0 ok, 1 error.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

REGISTRY = '/data/.openclaw/qdrant-models.json'
OPENCLAW_JSON = '/data/.openclaw/openclaw.json'
PROVIDERS = ('ollama', 'openai', 'gemini')


class QdrantError(RuntimeError):
    pass


# ── settings ──────────────────────────────────────────────────────────────

def _gateway_env(name):
    """A variable from our environment, else from the gateway process."""
    if os.environ.get(name):
        return os.environ[name]
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open(f'/proc/{pid}/environ', 'rb') as f:
                for item in f.read().split(b'\0'):
                    k, _, v = item.partition(b'=')
                    if k == name.encode() and v:
                        return v.decode()
        except OSError:
            continue
    return ''


def _qdrant_url():
    url = _gateway_env('QDRANT_URL').rstrip('/')
    if not url:
        raise QdrantError('QDRANT_URL is not set; run this inside the openclaw container.')
    return url


def _openclaw_cfg():
    try:
        with open(OPENCLAW_JSON) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def default_model():
    """(provider, model) from Configure AI Provider → Memory Embeddings, or None."""
    cfg = _openclaw_cfg()
    s = (cfg.get('memory') or {}).get('search') or {}
    p, m = s.get('provider'), s.get('model')
    if p == 'ollama-embed' and m:
        return 'ollama', m
    if p == 'openai':
        return 'openai', m or 'text-embedding-3-small'
    if p == 'gemini' and m:
        return 'gemini', m
    return None


def _ollama_base():
    cfg = _openclaw_cfg()
    base = ((cfg.get('models') or {}).get('providers') or {}).get('ollama-embed', {}).get('baseUrl')
    return (base or _gateway_env('OLLAMA_URL')).rstrip('/')


# ── HTTP ──────────────────────────────────────────────────────────────────

def _call(method, url, body=None, headers=None, timeout=30):
    hdrs = {'Content-Type': 'application/json', **(headers or {})}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode(errors='replace')
        raise QdrantError(f'{method} {url.split("?")[0]} -> HTTP {e.code}: {detail}') from None
    except (urllib.error.URLError, OSError) as e:
        raise QdrantError(f'{url.split("?")[0]} unreachable: {getattr(e, "reason", e)}') from None


def _q(method, path, body=None):
    return _call(method, _qdrant_url() + path, body).get('result')


# ── embeddings ────────────────────────────────────────────────────────────

def _auth(env_name, header, prefix, label):
    """Request header carrying a provider credential from the gateway env."""
    value = _gateway_env(env_name)
    if not value:
        raise QdrantError(f'No {label} key: add one in Configure AI Provider.')
    return {header: prefix + value}


def embed(text, provider, model):
    """One vector for `text` with the given provider and model."""
    if provider == 'ollama':
        base = _ollama_base()
        if not base:
            raise QdrantError('No Ollama URL: set Memory Embeddings to Ollama, or enable Ollama in Configure External Services.')
        return _call('POST', f'{base}/api/embed', {'model': model, 'input': text})['embeddings'][0]
    if provider == 'openai':
        hdrs = _auth('OPENAI_API_KEY', 'Authorization', 'Bearer ', 'OpenAI')
        r = _call('POST', 'https://api.openai.com/v1/embeddings', {'model': model, 'input': text}, hdrs)
        return r['data'][0]['embedding']
    if provider == 'gemini':
        hdrs = _auth('GEMINI_API_KEY', 'x-goog-api-key', '', 'Gemini')
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:embedContent'
        return _call('POST', url, {'content': {'parts': [{'text': text}]}}, hdrs)['embedding']['values']
    raise QdrantError(f'Unknown embedding provider {provider!r} (use one of {", ".join(PROVIDERS)}).')


# ── registry: collection -> model ─────────────────────────────────────────

def _registry():
    try:
        with open(REGISTRY) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_registry(reg):
    tmp = REGISTRY + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(reg, f, indent=2, sort_keys=True)
    os.replace(tmp, REGISTRY)


def model_of(collection):
    """(provider, model) recorded for a collection, or raise with the fix."""
    m = _registry().get(collection)
    if not m:
        raise QdrantError(
            f'The embedding model of collection "{collection}" is not recorded. Find out which model '
            f'built it (workspace notes, the ingest script), then: '
            f'python3 /opt/skills/qdrant/qdrant.py set-model {collection} <provider> <model>')
    return m['provider'], m['model']


def vector_size(collection):
    info = _q('GET', f'/collections/{urllib.parse.quote(collection)}')
    vec = info['config']['params']['vectors']
    if isinstance(vec, dict) and 'size' in vec:
        return int(vec['size'])
    raise QdrantError(f'Collection "{collection}" uses named vectors; this helper handles single-vector collections.')


def _check(collection, vector):
    size = vector_size(collection)
    if len(vector) != size:
        raise QdrantError(
            f'Vector size {len(vector)} does not match collection "{collection}" ({size}). '
            f'It was built with another embedding model; use that model, or re-embed into a new collection.')


def set_model(collection, provider, model):
    """Record (and prove) the model of an existing collection."""
    if provider not in PROVIDERS:
        raise QdrantError(f'provider must be one of {", ".join(PROVIDERS)}')
    vec = embed('dimension check', provider, model)
    _check(collection, vec)
    reg = _registry()
    reg[collection] = {'provider': provider, 'model': model, 'size': len(vec)}
    _save_registry(reg)
    return reg[collection]


def create(collection, provider=None, model=None, distance='Cosine'):
    """Create a collection for a model (default: the Memory Embeddings model) and record it."""
    if not (provider and model):
        dm = default_model()
        if not dm:
            raise QdrantError('No default embedding model: choose Memory Embeddings in Configure AI Provider, or pass provider and model.')
        provider, model = dm
    vec = embed('dimension check', provider, model)
    _q('PUT', f'/collections/{urllib.parse.quote(collection)}',
       {'vectors': {'size': len(vec), 'distance': distance}})
    reg = _registry()
    reg[collection] = {'provider': provider, 'model': model, 'size': len(vec)}
    _save_registry(reg)
    return reg[collection]


# ── data operations ───────────────────────────────────────────────────────

def collections():
    reg = _registry()
    out = []
    for c in sorted(x['name'] for x in _q('GET', '/collections')['collections']):
        info = _q('GET', f'/collections/{urllib.parse.quote(c)}')
        vec = info['config']['params']['vectors']
        size = vec.get('size') if isinstance(vec, dict) else None
        r = reg.get(c)
        out.append({'name': c, 'size': size, 'points': info.get('points_count'),
                    'model': f"{r['provider']}/{r['model']}" if r else None})
    return out


def search(collection, text=None, vector=None, limit=5, query_filter=None):
    """Nearest points to `text` (embedded with the collection's model) or `vector`."""
    if vector is None:
        if text is None:
            raise QdrantError('search needs text or vector')
        vector = embed(text, *model_of(collection))
    _check(collection, vector)
    body = {'vector': vector, 'limit': limit, 'with_payload': True}
    if query_filter:
        body['filter'] = query_filter
    return _q('POST', f'/collections/{urllib.parse.quote(collection)}/points/search', body)


def upsert(collection, points):
    """points: [{'text': ..., 'payload': {...}, 'id': optional}] or with 'vector'.
    The text is also stored in the payload (as 'text') so the collection can be
    re-embedded later with another model."""
    prepared = []
    model = None
    for p in points:
        vec = p.get('vector')
        payload = dict(p.get('payload') or {})
        if vec is None:
            if 'text' not in p:
                raise QdrantError('each point needs text or vector')
            model = model or model_of(collection)
            vec = embed(p['text'], *model)
        if 'text' in p:
            payload.setdefault('text', p['text'])
        prepared.append({'id': p.get('id') or str(uuid.uuid4()), 'vector': vec, 'payload': payload})
    if prepared:
        _check(collection, prepared[0]['vector'])
    return _q('PUT', f'/collections/{urllib.parse.quote(collection)}/points?wait=true', {'points': prepared})


# ── CLI ───────────────────────────────────────────────────────────────────

def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        print(__doc__.split('From a shell:')[1].split('Providers:')[0].strip())
        return 0
    cmd, args = argv[0], argv[1:]
    try:
        if cmd == 'list':
            for c in collections():
                print(f"{c['name']:<28} size={c['size']} points={c['points']} model={c['model'] or 'NOT RECORDED'}")
            dm = default_model()
            print(f"default for new collections: {dm[0] + '/' + dm[1] if dm else 'none (set Memory Embeddings)'}")
        elif cmd == 'search' and len(args) >= 2:
            limit = int(args[args.index('--limit') + 1]) if '--limit' in args else 5
            for hit in search(args[0], text=args[1], limit=limit):
                pl = hit.get('payload') or {}
                snippet = str(pl.get('text') or pl.get('body') or '')[:200].replace('\n', ' ')
                print(f"{hit.get('score', 0):.3f}  {hit.get('id')}  {snippet}")
        elif cmd == 'set-model' and len(args) == 3:
            print(json.dumps(set_model(*args)))
        elif cmd == 'create' and len(args) in (1, 3):
            print(json.dumps(create(*args)))
        else:
            print('usage: qdrant.py list | search COLLECTION "query" [--limit N] | '
                  'set-model COLLECTION PROVIDER MODEL | create COLLECTION [PROVIDER MODEL]', file=sys.stderr)
            return 1
    except QdrantError as e:
        print(f'qdrant: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    if os.geteuid() == 0 and os.path.isdir('/data'):
        # The registry lives on /data and belongs to the gateway user (node).
        os.execvp('runuser', ['runuser', '-u', 'node', '--', 'env', 'HOME=/data',
                              sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit(main(sys.argv[1:]))
