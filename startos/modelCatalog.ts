import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { sdk } from './sdk'
import { authProfilesJson } from './fileModels/authProfiles.json'
import { embeddingsJson } from './fileModels/embeddings.json'

// Live model lists for the Configure AI Provider dropdowns.
//
// When the form opens, each cloud provider with a saved API key is asked for
// its current models (chat and embedding). Results are cached on the data
// volume, so a provider that is slow or offline still shows the last list it
// returned, and the built-in list is the final fallback. The dropdown values
// are always the union of live, cached, built-in and currently configured
// models: StartOS validates the submitted value against the list rebuilt at
// submit time, and a model chosen a moment ago must never be rejected.

export type CloudProvider = 'anthropic' | 'openai' | 'google' | 'xai'
export type Kind = 'chat' | 'embed'
type Entry = [id: string, label: string]
type Lists = { chat: Entry[]; embed: Entry[] }

const CACHE_FILE = sdk.volumes.main.subpath('.startos/model-catalog.json')
const FETCH_TIMEOUT_MS = 6_000
const MEMO_MS = 60_000
const MAX_ENTRIES = 40

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as any
}

const byNewest = <T extends { t: number }>(a: T, b: T) => b.t - a.t
const toEntries = (rows: { id: string; label: string; t: number }[]) =>
  rows
    .sort(byNewest)
    .slice(0, MAX_ENTRIES)
    .map((r): Entry => [r.id, r.label])

// ── Per-provider fetchers ───────────────────────────────────────────────────

async function fetchAnthropic(key: string): Promise<Lists> {
  const j = await getJson('https://api.anthropic.com/v1/models?limit=1000', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  })
  const rows = ((j?.data ?? []) as any[])
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({
      id: m.id,
      label: m.display_name ? `${m.display_name} (${m.id})` : m.id,
      t: Date.parse(m.created_at ?? '') || 0,
    }))
  return { chat: toEntries(rows), embed: [] }
}

// OpenAI's list has no type field; classify by id.
const OPENAI_NOT_CHAT =
  /embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|davinci|babbage|instruct|sora|codex-mini|computer-use/i
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/i

async function fetchOpenai(key: string): Promise<Lists> {
  const j = await getJson('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${key}`,
  })
  const all = ((j?.data ?? []) as any[]).filter(
    (m) => typeof m?.id === 'string' && !m.shutdown_date,
  )
  const row = (m: any) => ({
    id: m.id,
    label: m.id,
    t: (m.created ?? 0) * 1000,
  })
  return {
    chat: toEntries(
      all
        .filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
        .map(row),
    ),
    embed: toEntries(all.filter((m) => /embedding/i.test(m.id)).map(row)),
  }
}

const GEMINI_NOT_CHAT = /embedding|imagen|veo|aqa|tts|-image|learnlm|gemma/i

async function fetchGoogle(key: string): Promise<Lists> {
  const models: any[] = []
  let token = ''
  for (let page = 0; page < 5; page++) {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' +
      (token ? `&pageToken=${encodeURIComponent(token)}` : '')
    const j = await getJson(url, { 'x-goog-api-key': key })
    models.push(...((j?.models ?? []) as any[]))
    token = j?.nextPageToken ?? ''
    if (!token) break
  }
  // No creation date in this API: keep Google's order (newest families first).
  const row = (m: any, i: number) => ({
    id: String(m.name).replace(/^models\//, ''),
    label: m.displayName
      ? `${m.displayName} (${String(m.name).replace(/^models\//, '')})`
      : String(m.name).replace(/^models\//, ''),
    t: -i,
  })
  const methods = (m: any) => (m?.supportedGenerationMethods ?? []) as string[]
  return {
    chat: toEntries(
      models
        .filter(
          (m) =>
            methods(m).includes('generateContent') &&
            !GEMINI_NOT_CHAT.test(String(m.name)),
        )
        .map(row),
    ),
    embed: toEntries(
      models.filter((m) => methods(m).includes('embedContent')).map(row),
    ),
  }
}

async function fetchXai(key: string): Promise<Lists> {
  const j = await getJson('https://api.x.ai/v1/language-models', {
    Authorization: `Bearer ${key}`,
  })
  const list = ((j?.models ?? j?.data ?? []) as any[]).filter(
    (m) =>
      typeof m?.id === 'string' &&
      (!Array.isArray(m.output_modalities) ||
        m.output_modalities.includes('text')),
  )
  return {
    chat: toEntries(
      list.map((m) => ({ id: m.id, label: m.id, t: (m.created ?? 0) * 1000 })),
    ),
    embed: [],
  }
}

const FETCHERS: Record<CloudProvider, (key: string) => Promise<Lists>> = {
  anthropic: fetchAnthropic,
  openai: fetchOpenai,
  google: fetchGoogle,
  xai: fetchXai,
}

// ── Keys, cache, memo ───────────────────────────────────────────────────────

async function keyFor(p: CloudProvider): Promise<string | undefined> {
  const profiles =
    (await authProfilesJson
      .read((f) => f.profiles)
      .once()
      .catch(() => undefined)) ?? {}
  const chat = profiles[`${p}:default`]
  if (chat?.type === 'token' && chat.token) return chat.token
  const emb = await embeddingsJson
    .read()
    .once()
    .catch(() => undefined)
  return emb?.provider === p && emb.apiKey ? emb.apiKey : undefined
}

type CacheFile = Partial<Record<CloudProvider, Lists & { at: string }>>

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as CacheFile
  } catch {
    return {}
  }
}

let cacheWrite: Promise<void> = Promise.resolve()
function saveCache(p: CloudProvider, lists: Lists) {
  // Serialize writes: several dropdowns refresh in parallel.
  cacheWrite = cacheWrite
    .then(async () => {
      const cache = await readCache()
      cache[p] = { ...lists, at: new Date().toISOString() }
      await mkdir(dirname(CACHE_FILE), { recursive: true })
      await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2))
    })
    .catch(() => {})
  return cacheWrite
}

const memo = new Map<CloudProvider, { at: number; p: Promise<Lists | null> }>()

/** Live lists for a provider, or null (no key, error, timeout). Memoized briefly
 * so the primary and fallback dropdowns share one request. */
function live(p: CloudProvider): Promise<Lists | null> {
  const hit = memo.get(p)
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.p
  const promise = (async () => {
    const key = await keyFor(p)
    if (!key) return null
    try {
      const lists = await FETCHERS[p](key)
      if (lists.chat.length || lists.embed.length) await saveCache(p, lists)
      return lists
    } catch {
      return null
    }
  })()
  memo.set(p, { at: Date.now(), p: promise })
  return promise
}

/**
 * Models the provider lists but the bundled OpenClaw cannot drive yet (it
 * predates them and builds a request they reject). They are left out of every
 * dropdown; a model already configured stays selectable, marked. Empty since
 * OpenClaw 2026.9.8, which drives Claude Opus/Sonnet 5.5 and GPT-6; refill it
 * if a provider ships a model ahead of the bundled OpenClaw again. Keep in
 * sync with skills/agents/agents.py UNSUPPORTED.
 */
const UNSUPPORTED: Partial<Record<CloudProvider, RegExp>> = {}

export const isUnsupported = (p: CloudProvider, id: string) =>
  !!UNSUPPORTED[p]?.test(id)

/**
 * Dropdown values for one provider and kind: live first, then cached, then the
 * built-in list, then any currently configured ids. Never empty.
 */
export async function catalog(
  p: CloudProvider,
  kind: Kind,
  builtin: Record<string, string>,
  current: (string | undefined)[] = [],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const add = (id: string | undefined, label: string) => {
    if (id && !(id in out) && !isUnsupported(p, id)) out[id] = label
  }
  const fresh = await live(p)
  for (const [id, label] of fresh?.[kind] ?? []) add(id, label)
  const cached = (await readCache())[p]
  for (const [id, label] of cached?.[kind] ?? []) add(id, label)
  for (const [id, label] of Object.entries(builtin)) add(id, label)
  // Configured ids always stay selectable (marked when unsupported).
  for (const id of current) {
    if (id && !(id in out)) {
      out[id] = isUnsupported(p, id)
        ? `${id} (current; not supported by this OpenClaw version)`
        : `${id} (current)`
    }
  }
  return out
}

// ── Your own Ollama server (local chat models for agents) ───────────────────
//
// The models a user's Ollama server has pulled, with what OpenClaw needs to
// know about each. Only models that can call tools are offered for chat:
// every OpenClaw agent works through tools, and an embedding-only or
// tool-less model would fail on its first turn.

/** models.providers id for the user's own Ollama server (chat models). */
export const OLLAMA_SERVER_ID = 'ollama-server'

export type LocalModel = {
  id: string
  tools: boolean
  embedOnly: boolean
  vision: boolean
  thinking: boolean
  contextWindow?: number
}

const LOCAL_CACHE_KEY = 'ollama-server'
const localMemo = new Map<
  string,
  { at: number; p: Promise<LocalModel[] | null> }
>()

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as any
}

async function fetchOllamaServer(baseUrl: string): Promise<LocalModel[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const tags = await getJson(`${base}/api/tags`, {})
  const names = ((tags?.models ?? []) as any[])
    .map((m) => String(m?.name ?? m?.model ?? ''))
    .filter(Boolean)
  const out = await Promise.all(
    names.map(async (id): Promise<LocalModel> => {
      try {
        const show = await postJson(`${base}/api/show`, { model: id })
        const caps = ((show?.capabilities ?? []) as string[]).map(String)
        const info = (show?.model_info ?? {}) as Record<string, unknown>
        const arch = String(info['general.architecture'] ?? '')
        const ctx = Number(info[`${arch}.context_length`])
        return {
          id,
          tools: caps.includes('tools'),
          embedOnly: caps.includes('embedding') && !caps.includes('completion'),
          vision: caps.includes('vision'),
          thinking: caps.includes('thinking'),
          contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : undefined,
        }
      } catch {
        // Unknown capabilities: not offered (we can't tell it calls tools).
        return {
          id,
          tools: false,
          embedOnly: false,
          vision: false,
          thinking: false,
        }
      }
    }),
  )
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function readLocalCache(): Promise<LocalModel[]> {
  const c = (await readCache()) as any
  return (c?.[LOCAL_CACHE_KEY]?.models ?? []) as LocalModel[]
}

/**
 * Every model on the user's Ollama server, live (cached on success); the last
 * list seen when the server can't be reached; [] when there is none.
 */
export async function ollamaServerModels(
  baseUrl: string | undefined,
): Promise<{ models: LocalModel[]; live: boolean }> {
  if (!baseUrl) return { models: [], live: false }
  const hit = localMemo.get(baseUrl)
  const p =
    hit && Date.now() - hit.at < MEMO_MS
      ? hit.p
      : (() => {
          const promise = fetchOllamaServer(baseUrl)
            .then(async (models) => {
              cacheWrite = cacheWrite
                .then(async () => {
                  const cache = (await readCache()) as any
                  cache[LOCAL_CACHE_KEY] = {
                    models,
                    at: new Date().toISOString(),
                  }
                  await mkdir(dirname(CACHE_FILE), { recursive: true })
                  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2))
                })
                .catch(() => {})
              await cacheWrite
              return models
            })
            .catch(() => null)
          localMemo.set(baseUrl, { at: Date.now(), p: promise })
          return promise
        })()
  const fresh = await p
  return fresh
    ? { models: fresh, live: true }
    : { models: await readLocalCache(), live: false }
}

/** The models.providers entry for one local model (what OpenClaw needs). */
export function localModelEntry(m: LocalModel | { id: string }) {
  const lm = m as Partial<LocalModel> & { id: string }
  return {
    id: lm.id,
    name: lm.id,
    input: lm.vision ? ['text', 'image'] : ['text'],
    ...(lm.thinking ? { reasoning: true } : {}),
    ...(lm.contextWindow
      ? {
          contextWindow: lm.contextWindow,
          // Same cap OpenClaw's own Ollama discovery uses: keeps num_ctx sane
          // on small machines while overriding Ollama's tiny 4k default.
          contextTokens: Math.min(lm.contextWindow, 32_768),
        }
      : {}),
  }
}

/**
 * Every chat model an agent can be given, as `provider/model` → label:
 * cloud providers with a saved key (live, cached or built-in), then the
 * tool-capable models of the user's Ollama server, then `current` ids.
 */
export async function agentModelChoices(
  builtins: Partial<Record<CloudProvider, Record<string, string>>>,
  ollamaServerUrl: string | undefined,
  current: (string | undefined)[] = [],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const add = (id: string | undefined, label: string) => {
    if (id && !(id in out)) out[id] = label
  }
  const NAMES: Record<CloudProvider, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    xai: 'xAI',
  }
  for (const p of ['anthropic', 'openai', 'google', 'xai'] as CloudProvider[]) {
    if (!(await keyFor(p))) continue
    const values = await catalog(p, 'chat', builtins[p] ?? {})
    for (const [id, label] of Object.entries(values)) {
      add(`${p}/${id}`, `${NAMES[p]} · ${label}`)
    }
  }
  if (ollamaServerUrl) {
    const { models } = await ollamaServerModels(ollamaServerUrl)
    for (const m of models) {
      if (m.tools && !m.embedOnly)
        add(`${OLLAMA_SERVER_ID}/${m.id}`, `Local · ${m.id}`)
    }
  }
  for (const id of current) {
    if (id && !(id in out)) {
      const [prov, ...rest] = id.split('/')
      out[id] = isUnsupported(prov as CloudProvider, rest.join('/'))
        ? `${id} (current; not supported by this OpenClaw version)`
        : `${id} (current)`
    }
  }
  return out
}

/** A default that is guaranteed to be one of `values`. */
export function pickDefault(values: Record<string, string>, preferred: string) {
  return preferred in values ? preferred : (Object.keys(values)[0] ?? preferred)
}
