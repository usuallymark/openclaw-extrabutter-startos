---
name: qdrant
description: "Use this skill for vector database work in Qdrant: semantic search over a knowledge collection, storing new knowledge, creating or listing collections. Triggers: search a library or knowledge base, remember something long-term in a collection, ingest documents, anything about embeddings or Qdrant."
---

# Qdrant — Vector Database

Qdrant runs inside this OpenClaw package (internal only, no API key). Use
the helper below; it knows the address (`QDRANT_URL`).

## The one rule: a collection keeps its embedding model

Every collection was built with one embedding model. Search it, and add
to it, only with that same model. A different model's vectors are useless
there: a different vector size is rejected, and the same size silently
returns nonsense. Changing Memory Embeddings in Configure AI Provider does
**not** change existing collections.

The helper records each collection's model and uses it automatically.

## Use it

```python
import sys; sys.path.insert(0, '/opt/skills/qdrant')
import qdrant

qdrant.collections()          # [{'name', 'size', 'points', 'model'}, ...]
hits = qdrant.search('notes', 'what did we decide about backups?', limit=5)
for h in hits:
    print(h['score'], h['payload'].get('text', '')[:200])

qdrant.upsert('notes', [
    {'text': 'Backups run nightly at 2am.', 'payload': {'source': 'chat', 'date': '2026-10-05'}},
])
qdrant.create('new-collection')   # uses the Memory Embeddings model
```

Shell:

```bash
python3 /opt/skills/qdrant/qdrant.py list
python3 /opt/skills/qdrant/qdrant.py search notes "what did we decide about backups?" --limit 5
python3 /opt/skills/qdrant/qdrant.py create new-collection
```

- `upsert` stores the original text in the payload (`text`). Keep it that
  way: it is what makes a collection re-embeddable with another model later.
- Filters: `qdrant.search(name, text, query_filter={'must': [{'key': 'source', 'match': {'value': 'chat'}}]})`.

## A collection with no recorded model

`list` shows `model=NOT RECORDED` and search refuses it. Find out which
model built it (workspace notes, the ingest script), then record it once:

```bash
python3 /opt/skills/qdrant/qdrant.py set-model COLLECTION ollama nomic-embed-text
```

`set-model` embeds a test string and refuses the model if the vector size
does not match the collection. (A same-size wrong model cannot be detected
this way: be sure of the model before recording it.) Providers: `ollama`,
`openai`, `gemini`; keys and the Ollama address come from Configure AI
Provider / Configure External Services.

## Don't

- Don't embed with a different model "just this once" and don't create
  vectors by hand for an existing collection; use the helper.
- Don't delete or recreate a collection to change its model. Moving a
  collection to a new model is a deliberate re-embed into a new
  collection; ask the user first.
- Collection names and what they hold are the user's business: keep notes
  about them in the workspace, not in package skills.
