---
name: ollama
description: "Use this skill for local AI model operations: generating embeddings, vision/image analysis, and running local language models. Triggers: embedding text for Qdrant, analyzing images, or any task requiring a local model."
---

# Ollama — Local AI Models

## Purpose

Ollama runs models on the user's own hardware: embeddings, vision analysis
and local language models. Which models are installed is up to the user;
check with the list below before assuming one exists.

## Connection

```python
import os
OLLAMA_URL = os.environ.get('OLLAMA_URL')
if not OLLAMA_URL:
    raise RuntimeError('Ollama is not configured. Enable it in Configure External Services.')
```

## Generate Embeddings

For Qdrant collections use the qdrant skill instead: it picks the model each
collection was built with. Direct use, e.g. to compare two texts:

```python
import json, urllib.request, os

OLLAMA_URL = os.environ.get('OLLAMA_URL')

def embed(text):
    body = json.dumps({'model': 'nomic-embed-text', 'input': text}).encode()
    req = urllib.request.Request(
        f'{OLLAMA_URL}/api/embed',
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())['embeddings'][0]

vector = embed('Your text here')
```

## Vision / Image Analysis

Analyze images from a file path or base64 data:

```python
import base64, json, urllib.request, os

OLLAMA_URL = os.environ.get('OLLAMA_URL')

def analyze_image(image_path, prompt='Describe this image in detail.'):
    with open(image_path, 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()

    body = json.dumps({
        'model': 'llama3.2-vision:11b',
        'prompt': prompt,
        'images': [img_b64],
        'stream': False
    }).encode()

    req = urllib.request.Request(
        f'{OLLAMA_URL}/api/generate',
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    resp = urllib.request.urlopen(req, timeout=120)
    return json.loads(resp.read())['response']

# Example: extract colors from an image
result = analyze_image(
    '/path/to/image.jpg',
    'Identify the dominant colors. For each, give the hex code and plain English name.'
)
print(result)
```

## Check Available Models

```python
req = urllib.request.Request(f'{OLLAMA_URL}/api/tags')
resp = urllib.request.urlopen(req, timeout=5)
models = [m['name'] for m in json.loads(resp.read()).get('models', [])]
print(models)
```

## Common Models

Examples only; use what `/api/tags` lists:
- `nomic-embed-text` — small, fast embedding model
- `llama3.2-vision:11b` — vision/image analysis
