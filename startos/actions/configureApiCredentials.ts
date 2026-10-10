import { T } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { authProfilesJson, AuthProfile } from '../fileModels/authProfiles.json'
import { openclawJson } from '../fileModels/openclaw.json'
import { readDependencyApiKey } from '../utils'
import { embeddingsJson } from '../fileModels/embeddings.json'
import { externalServicesJson } from '../fileModels/externalServices.json'
import {
  catalog,
  CloudProvider,
  localModelEntry,
  OLLAMA_SERVER_ID,
  ollamaServerModels,
  pickDefault,
} from '../modelCatalog'
import { i18n } from '../i18n'

const { InputSpec, Value, Variants } = sdk

// Cloud providers OpenClaw resolves from environment API keys (the path main.ts
// bridges and the only one current OpenClaw builds read at runtime — see #12).
// The union key is OpenClaw's provider prefix in `provider/model` refs; the env
// var is what main.ts sets. Keep both in sync with main.ts `providerKeyEnvVar`.
const MANAGED_PROVIDERS = ['anthropic', 'openai', 'google', 'xai'] as const

// Local inference backends route to the matching StartOS package over the LXC
// bridge. The save handler writes a `models.providers.<id>` entry pointing at
// the dependency's resolved bridge endpoint (`depApiBaseUrl` + `path`); the
// union key is also the `provider/model` prefix and the dependency id
// setupDependencies gates on. Ollama uses its native API (`api: "ollama"`, NO
// `/v1` — `/v1` breaks tool calling); vLLM/llama.cpp are OpenAI-compatible
// (`/v1`). needsKey backends read a real key from the dependency's published
// credentials; the rest take any value on a private LAN.
const LOCAL_BACKENDS: Record<
  string,
  { path: string; api: string; needsKey: boolean }
> = {
  ollama: { path: '', api: 'ollama', needsKey: false },
  vllm: { path: '/v1', api: 'openai-completions', needsKey: true },
  'llama-cpp': { path: '/v1', api: 'openai-completions', needsKey: false },
}

// Local-inference deps (ollama/vLLM/llama.cpp) each export an OpenAI-compatible
// `api` interface on a MultiHost named `api-multi`. Resolve its plain-HTTP
// LXC-bridge base URL (e.g. `http://10.0.3.5:11434`) at apply time — the retired
// `<pkg>.startos` DNS no longer resolves between containers. String-literal ids
// because these are optional runtime deps, not npm `-startos` packages whose id
// constants we could import.
const DEP_API_HOST_ID = 'api-multi'
const DEP_API_INTERFACE_ID = 'api'

const depApiBaseUrl = (effects: T.Effects, packageId: string) =>
  sdk.host
    .get(effects, { hostId: DEP_API_HOST_ID, packageId }, (host) => {
      const iface =
        host &&
        Object.values(host.bindings)
          .flatMap((b) => Object.values(b.interfaces))
          .find((i) => i.id === DEP_API_INTERFACE_ID)
      return iface
        ? iface.addressInfo
            .filter({ kind: 'bridge', predicate: (h) => !h.ssl })
            .format('urlstring')[0]
        : undefined
    })
    .once()

// Curated default-model catalogs (exact API model id → label). The chosen model
// is only the default; it can be changed anytime from Web UI chat with /model,
// and the Custom Model field below accepts any id not yet listed.
// Built-in lists are only the fallback: when the form opens, providers with a
// saved key are asked for their current models (see modelCatalog.ts).
export const ANTHROPIC_MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': i18n('Claude Opus 4.7'),
  'claude-sonnet-4-6': i18n('Claude Sonnet 4.6 — balanced'),
  'claude-haiku-4-5': i18n('Claude Haiku 4.5 — fast & cheap'),
  'claude-fable-5': i18n('Claude Fable 5 — premium'),
}
export const OPENAI_MODELS = {
  'gpt-5.5': i18n('GPT-5.5 — strongest'),
  'gpt-5.4': i18n('GPT-5.4'),
  'gpt-5.4-mini': i18n('GPT-5.4 Mini — fast & cheap'),
}
export const GEMINI_MODELS = {
  'gemini-3.1-pro-preview': i18n('Gemini 3.1 Pro'),
  'gemini-3-flash-preview': i18n('Gemini 3 Flash — fast'),
}
export const GROK_MODELS = {
  'grok-4.3': i18n('Grok 4.3 — flagship'),
  'grok-build-0.1': i18n('Grok Build 0.1 — agentic coding'),
}

// Default-model dropdown + an optional Custom field, so a brand-new id can be
// used without waiting for a package update. `pickModel` resolves the pair.
// Configured `provider/model` ids, so the current choice is always selectable.
async function currentModels(provider: string) {
  const m = await openclawJson
    .read((c) => c.agents?.defaults?.model)
    .once()
    .catch(() => undefined)
  return [m?.primary, ...(m?.fallbacks ?? [])]
    .filter((id): id is string => !!id && id.startsWith(`${provider}/`))
    .map((id) => id.slice(provider.length + 1))
}

const modelDropdown = (
  provider: CloudProvider,
  builtin: Record<string, string>,
  def: string,
) => ({
  model: Value.dynamicSelect(async () => {
    const values = await catalog(
      provider,
      'chat',
      builtin,
      await currentModels(provider),
    )
    return {
      name: i18n('Default Model'),
      description: i18n(
        'The model this provider uses by default. The list comes live from the provider when its API key is saved (otherwise a built-in list). Change it anytime from Web UI chat with the /model command.',
      ),
      default: pickDefault(values, def),
      values,
    }
  }),
  customModel: Value.text({
    name: i18n('Custom Model (optional)'),
    description: i18n(
      'Use an exact model id that is not in the list above. Leave blank to use the dropdown selection.',
    ),
    required: false,
    default: null,
    placeholder: def,
  }),
})

const apiKeyField = (placeholder: string) =>
  Value.text({
    name: i18n('API Key'),
    description: i18n(
      'API key for this provider. Leave blank to keep the key already saved.',
    ),
    required: false,
    default: null,
    masked: true,
    placeholder,
  })

// Resolve the model from a dropdown+custom pair — a filled Custom field wins.
const pickModel = (v: { model?: string; customModel?: string | null }) =>
  (v.customModel ?? '').trim() || v.model || ''

// Prefill a dropdown+custom pair: select a known id, else route an unknown
// (custom) id to the Custom field. Never returns an API key (keys aren't echoed).
// The dropdown always includes the configured id (see currentModels).
const prefillModel = (
  _builtin: Record<string, string>,
  id: string | undefined,
) => (id == null ? {} : { model: id })

const providerSpec = (
  provider: CloudProvider,
  models: Record<string, string>,
  def: string,
  keyPlaceholder: string,
) =>
  InputSpec.of({
    ...modelDropdown(provider, models, def),
    apiKey: apiKeyField(keyPlaceholder),
  })

const anthropic = {
  name: i18n('Anthropic (Claude)'),
  spec: providerSpec(
    'anthropic',
    ANTHROPIC_MODELS,
    'claude-opus-5-5',
    'sk-ant-...',
  ),
}
const openai = {
  name: i18n('OpenAI (GPT)'),
  spec: providerSpec('openai', OPENAI_MODELS, 'gpt-5.5', 'sk-...'),
}
const google = {
  name: i18n('Google (Gemini)'),
  spec: providerSpec(
    'google',
    GEMINI_MODELS,
    'gemini-3.1-pro-preview',
    'AIza...',
  ),
}
const xai = {
  name: i18n('xAI (Grok)'),
  spec: providerSpec('xai', GROK_MODELS, 'grok-4.3', 'xai-...'),
}

// Local backends take a single served-model field; baseUrl (and vLLM's key) are
// wired by the save handler into openclaw.json `models.providers.<id>`.
const servedModelField = (placeholder: string) =>
  Value.text({
    name: i18n('Default Model'),
    description: i18n(
      'The exact model id your local server serves. Change it anytime from Web UI chat with the /model command.',
    ),
    required: true,
    default: null,
    placeholder,
  })

const ollama = {
  name: i18n('Ollama (local)'),
  spec: InputSpec.of({ model: servedModelField('llama3.1:8b') }),
}
const vllm = {
  name: i18n('vLLM (local)'),
  spec: InputSpec.of({ model: servedModelField('Qwen/Qwen2.5-7B-Instruct') }),
}
const llamacpp = {
  name: i18n('llama.cpp (local)'),
  spec: InputSpec.of({
    model: servedModelField('the model your server serves'),
  }),
}

const allVariants = {
  anthropic,
  openai,
  google,
  xai,
  ollama,
  vllm,
  'llama-cpp': llamacpp,
}

const primaryVariants = Variants.of(allVariants)
const fallbackVariants = Variants.of({
  disabled: { name: i18n('Disabled'), spec: InputSpec.of({}) },
  ...allVariants,
})

// ── Memory embeddings (OpenClaw memory search) ─────────────────────────────
// Independent of the chat provider. Writes openclaw.json `memory.search`.
// Qdrant collections are NOT affected: each keeps the model it was built with.

const EMBED_OPENAI = {
  'text-embedding-3-small': 'text-embedding-3-small',
  'text-embedding-3-large': 'text-embedding-3-large',
}
const EMBED_GOOGLE = {
  'gemini-embedding-001': 'gemini-embedding-001',
}
// Custom models.providers id for an Ollama embedding server, so it does not
// collide with an Ollama chat backend.
const OLLAMA_EMBED_ID = 'ollama-embed'

const embedKeyField = (placeholder: string) =>
  Value.text({
    name: i18n('API Key'),
    description: i18n(
      'Only needed if this provider is not also your chat provider above (then its chat key is used). Leave blank to keep the key already saved.',
    ),
    required: false,
    default: null,
    masked: true,
    placeholder,
  })

const embedModelDropdown = (
  provider: CloudProvider,
  builtin: Record<string, string>,
  def: string,
) =>
  Value.dynamicSelect(async ({ effects }) => {
    const cur = await openclawJson
      .read((c) => c.memory?.search?.model)
      .once()
      .catch(() => undefined)
    const values = await catalog(provider, 'embed', builtin, [cur ?? undefined])
    return {
      name: i18n('Embedding Model'),
      description: i18n(
        'Listed live from the provider when a key for it is saved; otherwise a built-in list.',
      ),
      default: pickDefault(values, def),
      values,
    }
  })

const embeddingVariants = Variants.of({
  none: {
    name: i18n('Keyword search only (no embeddings)'),
    spec: InputSpec.of({}),
  },
  openai: {
    name: 'OpenAI',
    spec: InputSpec.of({
      model: embedModelDropdown(
        'openai',
        EMBED_OPENAI,
        'text-embedding-3-small',
      ),
      apiKey: embedKeyField('sk-...'),
    }),
  },
  google: {
    name: i18n('Google (Gemini)'),
    spec: InputSpec.of({
      model: embedModelDropdown('google', EMBED_GOOGLE, 'gemini-embedding-001'),
      apiKey: embedKeyField('AIza...'),
    }),
  },
  ollama: {
    name: i18n('Ollama (your own server)'),
    spec: InputSpec.of({
      url: Value.text({
        name: i18n('Ollama URL'),
        description: i18n(
          'Base URL of your Ollama server, without /v1 (e.g. http://192.168.1.50:11434). Defaults to the Ollama URL from Configure External Services. A ".local" name needs a Custom Host Mapping there.',
        ),
        required: true,
        default: null,
        placeholder: 'http://ollama-host:11434',
      }),
      model: Value.text({
        name: i18n('Embedding Model'),
        description: i18n(
          'An embedding model your Ollama server has pulled, e.g. nomic-embed-text.',
        ),
        required: true,
        default: 'nomic-embed-text',
        placeholder: 'nomic-embed-text',
      }),
    }),
  },
  'openai-compatible': {
    name: i18n('Other OpenAI-compatible server'),
    spec: InputSpec.of({
      url: Value.text({
        name: i18n('Base URL'),
        description: i18n(
          'Base URL of the /v1/embeddings API, e.g. https://api.example.com/v1/',
        ),
        required: true,
        default: null,
        placeholder: 'https://api.example.com/v1/',
      }),
      model: Value.text({
        name: i18n('Embedding Model'),
        description: null,
        required: true,
        default: null,
        placeholder: 'text-embedding-3-small',
      }),
      apiKey: Value.text({
        name: i18n('API Key'),
        description: i18n('Leave blank to keep the key already saved.'),
        required: false,
        default: null,
        masked: true,
        placeholder: null,
      }),
    }),
  },
})

// ── Local chat models (the user's own Ollama server) ───────────────────────
// Adds a `models.providers.ollama-server` entry listing the server's
// tool-capable models, so agents (Configure Agents) can run on them.
// Separate from the "Ollama (local)" chat backend above, which is the
// StartOS Ollama package.

const localModelsVariants = Variants.of({
  disabled: { name: i18n('Off'), spec: InputSpec.of({}) },
  ollama: {
    name: i18n('Ollama (your own server)'),
    spec: InputSpec.of({
      url: Value.text({
        name: i18n('Ollama URL'),
        description: i18n(
          'Base URL of your Ollama server, without /v1 (e.g. http://192.168.1.50:11434). Defaults to the Ollama URL from Configure External Services. A ".local" name needs a Custom Host Mapping there.',
        ),
        required: true,
        default: null,
        placeholder: 'http://ollama-host:11434',
      }),
    }),
  },
})

const inputSpec = InputSpec.of({
  primary: Value.union({
    name: i18n('Primary Provider'),
    description: i18n(
      'The backend your agent uses by default. Cloud providers (Anthropic, OpenAI, Google, xAI) need an API key; local backends (Ollama, vLLM, llama.cpp) run on your StartOS server and are added as a dependency.',
    ),
    default: 'anthropic',
    variants: primaryVariants,
  }),
  fallback: Value.union({
    name: i18n('Fallback Provider (optional)'),
    description: i18n(
      'Used automatically when the primary is rate-limited or unavailable. Choose Disabled to skip.',
    ),
    default: 'disabled',
    variants: fallbackVariants,
  }),
  embeddings: Value.union({
    name: i18n('Memory Embeddings'),
    description: i18n(
      "How OpenClaw's memory search (MEMORY.md, memory files, past sessions) finds related notes. Independent of the chat provider above.\n\nChanging it makes OpenClaw rebuild its memory index once (with a paid API this costs a little). Vector collections in Qdrant are NOT changed: each keeps the embedding model it was built with.",
    ),
    default: 'none',
    variants: embeddingVariants,
  }),
  localModels: Value.union({
    name: i18n('Local Chat Models for Agents'),
    description: i18n(
      'Offer the chat models on your own Ollama server to your agents (Configure Agents), so helper agents can run locally at no API cost.\n\nOnly models that can call tools are offered; embedding-only models are left out. Models you pull later appear in Configure Agents without saving this again. Local models are usually weaker than cloud models at multi-step tool work: try one on a narrow task first.',
    ),
    default: 'disabled',
    variants: localModelsVariants,
  }),
})

// --- Prefill helpers ---

function splitModelId(id: string | undefined) {
  if (!id) return undefined
  const i = id.indexOf('/')
  return i === -1
    ? { provider: 'anthropic', model: id }
    : { provider: id.slice(0, i), model: id.slice(i + 1) }
}

// Reconstruct a provider union value from a stored `provider/model` ref. Returns
// null for an unknown/unmanaged provider so the caller can fall back.
function prefillProvider(id: string | undefined) {
  const parsed = splitModelId(id)
  if (!parsed) return null
  switch (parsed.provider) {
    case 'anthropic':
      return {
        selection: 'anthropic' as const,
        value: prefillModel(ANTHROPIC_MODELS, parsed.model),
      }
    case 'openai':
      return {
        selection: 'openai' as const,
        value: prefillModel(OPENAI_MODELS, parsed.model),
      }
    case 'google':
      return {
        selection: 'google' as const,
        value: prefillModel(GEMINI_MODELS, parsed.model),
      }
    case 'xai':
      return {
        selection: 'xai' as const,
        value: prefillModel(GROK_MODELS, parsed.model),
      }
    case 'ollama':
      return { selection: 'ollama' as const, value: { model: parsed.model } }
    case 'vllm':
      return { selection: 'vllm' as const, value: { model: parsed.model } }
    case 'llama-cpp':
      return {
        selection: 'llama-cpp' as const,
        value: { model: parsed.model },
      }
    default:
      return null
  }
}

// Reconstruct the Memory Embeddings choice from openclaw.json. Unset means
// OpenClaw's own default (OpenAI); show it as such only when an OpenAI key is
// saved, otherwise as keyword-only, which is what an unset config does then.
async function prefillEmbeddings() {
  const cfg = await openclawJson
    .read()
    .once()
    .catch(() => undefined)
  const s = cfg?.memory?.search
  switch (s?.provider) {
    case 'none':
      return { selection: 'none' as const, value: {} }
    case 'openai':
      return { selection: 'openai' as const, value: { model: s.model } }
    case 'gemini':
      return { selection: 'google' as const, value: { model: s.model } }
    case OLLAMA_EMBED_ID: {
      const ext = await externalServicesJson
        .read()
        .once()
        .catch(() => undefined)
      return {
        selection: 'ollama' as const,
        value: {
          url:
            cfg?.models?.providers?.[OLLAMA_EMBED_ID]?.baseUrl ??
            ext?.ollama?.url ??
            undefined,
          model: s.model ?? 'nomic-embed-text',
        },
      }
    }
    case 'openai-compatible':
      return {
        selection: 'openai-compatible' as const,
        value: { url: s.remote?.baseUrl, model: s.model },
      }
  }
  const profiles =
    (await authProfilesJson
      .read((p) => p.profiles)
      .once()
      .catch(() => undefined)) ?? {}
  return profiles['openai:default']
    ? {
        selection: 'openai' as const,
        value: { model: 'text-embedding-3-small' },
      }
    : { selection: 'none' as const, value: {} }
}

async function prefillLocalModels() {
  const cfg = (await openclawJson
    .read()
    .once()
    .catch(() => undefined)) as any
  const url = cfg?.models?.providers?.[OLLAMA_SERVER_ID]?.baseUrl
  if (url) return { selection: 'ollama' as const, value: { url } }
  return { selection: 'disabled' as const, value: {} }
}

/** Agent ids whose model is on the user's Ollama server. */
function agentsOnLocal(cfg: any): string[] {
  const entries = (cfg?.agents?.entries ?? {}) as Record<string, any>
  const uses = (m: any) =>
    [
      typeof m === 'string' ? m : m?.primary,
      ...((m?.fallbacks as string[]) ?? []),
    ]
      .filter(Boolean)
      .some((r: string) => r.startsWith(`${OLLAMA_SERVER_ID}/`))
  return Object.entries(entries)
    .filter(([, e]) => uses(e?.model))
    .map(([id]) => id)
}

/**
 * Apply the Local Chat Models choice. On: (re)write the provider entry with
 * every tool-capable model the server has now, keeping any model an agent
 * still uses. Off: remove the entry, unless an agent still runs on it.
 */
async function applyLocalModels(
  effects: T.Effects,
  sel: { selection: string; value: { url?: string | null } },
) {
  const cfg = (await openclawJson.read().once()) as any
  const providers = { ...(cfg?.models?.providers ?? {}) }
  if (sel.selection !== 'ollama') {
    if (!providers[OLLAMA_SERVER_ID]) return
    const users = agentsOnLocal(cfg)
    if (users.length) {
      throw new Error(
        i18n(
          'Local Chat Models cannot be turned off while agents use them. Give these agents another model in Configure Agents first:',
        ) + ` ${users.join(', ')}`,
      )
    }
    delete providers[OLLAMA_SERVER_ID]
    await openclawJson.write(effects, {
      ...cfg,
      models: { ...(cfg?.models ?? {}), providers },
    })
    return
  }
  const base = (sel.value.url ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
  const { models, live } = await ollamaServerModels(base)
  if (!live) {
    throw new Error(
      i18n(
        'Could not reach your Ollama server to read its models. Check the URL (and a Custom Host Mapping for a ".local" name) and that Ollama is running, then save again.',
      ) + ` (${base})`,
    )
  }
  const keep = new Set(
    Object.values((cfg?.agents?.entries ?? {}) as Record<string, any>)
      .map((e) => (typeof e?.model === 'string' ? e.model : e?.model?.primary))
      .filter(
        (r: any) =>
          typeof r === 'string' && r.startsWith(`${OLLAMA_SERVER_ID}/`),
      )
      .map((r: string) => r.slice(OLLAMA_SERVER_ID.length + 1)),
  )
  const list = models
    .filter((m) => m.tools && !m.embedOnly)
    .map(localModelEntry)
  for (const id of keep) {
    if (!list.some((m) => m.id === id)) list.push(localModelEntry({ id }))
  }
  providers[OLLAMA_SERVER_ID] = {
    ...(providers[OLLAMA_SERVER_ID] ?? {}),
    api: 'ollama',
    baseUrl: base,
    apiKey: 'ollama-local',
    timeoutSeconds: 300,
    models: list,
  }
  await openclawJson.write(effects, {
    ...cfg,
    models: { mode: 'merge', ...(cfg?.models ?? {}), providers },
  })
}

// --- Save helper ---

type ProviderUnion = {
  selection: string
  value: { model?: string; customModel?: string | null; apiKey?: string | null }
}

type EmbeddingUnion = {
  selection: string
  value: { model?: string; url?: string | null; apiKey?: string | null }
}

// OpenClaw's memory-search provider id per form choice.
const EMBED_PROVIDER_ID: Record<string, string> = {
  none: 'none',
  openai: 'openai',
  google: 'gemini',
  ollama: OLLAMA_EMBED_ID,
  'openai-compatible': 'openai-compatible',
}

/**
 * Apply the Memory Embeddings choice: package-private key storage plus
 * openclaw.json `memory.search` (and a dedicated provider entry for Ollama).
 * Returns true when a cloud provider was chosen without any API key; it is
 * then saved as keyword-only.
 */
export async function applyEmbeddings(
  effects: T.Effects,
  emb: EmbeddingUnion,
  profiles: Record<string, AuthProfile>,
): Promise<boolean> {
  const sel = emb.selection
  const prevEmb = await embeddingsJson
    .read()
    .once()
    .catch(() => undefined)
  const cfg = (await openclawJson.read().once()) as any
  const prevSearch = (cfg?.memory?.search ?? {}) as Record<string, unknown>
  const { provider: _p, model: _m, remote: _r, ...keepSearch } = prevSearch
  const search: Record<string, unknown> = {
    ...keepSearch,
    provider: EMBED_PROVIDER_ID[sel] ?? 'none',
  }
  let keyMissing = false

  if (sel === 'openai' || sel === 'google') {
    // Bridged to OPENAI_API_KEY / GEMINI_API_KEY by main.ts, only when the
    // provider has no chat key (one key per provider; the chat key wins).
    const typed = (emb.value.apiKey ?? '').trim()
    const kept = prevEmb?.provider === sel ? prevEmb.apiKey : undefined
    const apiKey = typed || kept
    await embeddingsJson.write(effects, { provider: sel, apiKey })
    keyMissing = !apiKey && !profiles[`${sel}:default`]
    if (keyMissing) {
      // OpenClaw fails closed for a named cloud provider without a key
      // (memory search would report "unavailable"); keyword-only instead.
      search.provider = 'none'
    } else {
      search.model = emb.value.model
    }
  } else if (sel === 'openai-compatible') {
    const prevRemote = (prevSearch.remote ?? {}) as { apiKey?: string }
    const apiKey = (emb.value.apiKey ?? '').trim() || prevRemote.apiKey
    search.model = (emb.value.model ?? '').trim()
    search.remote = {
      baseUrl: (emb.value.url ?? '').trim(),
      ...(apiKey ? { apiKey } : {}),
    }
    await embeddingsJson.write(effects, { provider: sel })
  } else {
    await embeddingsJson.write(effects, { provider: sel })
    if (sel === 'ollama') search.model = (emb.value.model ?? '').trim()
  }

  const models = { mode: 'merge', ...(cfg?.models ?? {}) }
  if (sel === 'ollama') {
    // A dedicated provider entry, so an Ollama chat backend is untouched.
    const base = (emb.value.url ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '')
    const model = String(search.model)
    models.providers = {
      ...(models.providers ?? {}),
      [OLLAMA_EMBED_ID]: {
        api: 'ollama',
        baseUrl: base,
        apiKey: 'ollama-local',
        models: [{ id: model, name: model }],
      },
    }
  }
  await openclawJson.write(effects, {
    ...cfg,
    models,
    memory: { ...(cfg?.memory ?? {}), search },
  })
  return keyMissing
}

// --- Action ---

export const configureApiCredentials = sdk.Action.withInput(
  'configure-api-credentials',

  async ({ effects }) => ({
    name: i18n('Configure AI Provider'),
    description: i18n(
      'Choose the AI backend your agent uses — a cloud provider (with an API key) or a local model server (Ollama, vLLM, llama.cpp) — pick a model, and optionally add a fallback.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  // Pre-fill provider + model from the stored config. API keys are never echoed
  // back into the form (the field's `default: null` leaves them blank).
  async ({ effects }) => {
    const model = await openclawJson
      .read((c) => c.agents?.defaults?.model)
      .once()
      .catch(() => undefined)

    return {
      primary: prefillProvider(model?.primary) ?? {
        selection: 'anthropic' as const,
        value: {},
      },
      fallback: prefillProvider(model?.fallbacks?.[0]) ?? {
        selection: 'disabled' as const,
        value: {},
      },
      embeddings: await prefillEmbeddings(),
      localModels: await prefillLocalModels(),
    }
  },

  // Save: cloud providers write a token profile (bridged to env by main.ts);
  // local backends write a `models.providers.<id>` entry. Both set the
  // `provider/model` refs in openclaw.json, then restart.
  async ({ effects, input }) => {
    // First: it can refuse (server unreachable, agents still using it), and
    // nothing else should be saved then.
    await applyLocalModels(
      effects,
      input.localModels as {
        selection: string
        value: { url?: string | null }
      },
    )

    const existing: Record<string, AuthProfile> =
      (await authProfilesJson.read((p) => p.profiles).once()) ?? {}

    const profiles: Record<string, AuthProfile> = { ...existing }
    // Drop our managed cloud defaults; re-add only the providers selected below.
    // Separately-created profiles (e.g. OAuth, named accounts) are preserved.
    for (const p of MANAGED_PROVIDERS) delete profiles[`${p}:default`]

    type LocalEntry = {
      baseUrl: string
      apiKey: string
      api: string
      timeoutSeconds: number
      models: { id: string; name: string; input: string[] }[]
    }
    // models.providers entries for the selected local backend(s), deep-merged
    // into openclaw.json. A backend the user has stopped using lingers
    // harmlessly (inert once unreferenced; its dependency is dropped by
    // setupDependencies).
    const providers: Record<string, LocalEntry> = {}

    const resolve = async (u: ProviderUnion): Promise<string | undefined> => {
      if (u.selection === 'disabled') return undefined
      const sel = u.selection

      // Cloud provider — API key bridged to env via main.ts.
      if ((MANAGED_PROVIDERS as readonly string[]).includes(sel)) {
        const prev = existing[`${sel}:default`]
        const key =
          (u.value.apiKey ?? '').trim() ||
          (prev?.type === 'token' ? prev.token : undefined)
        if (key) {
          profiles[`${sel}:default`] = {
            type: 'token',
            provider: sel,
            token: key,
          }
        }
        return `${sel}/${pickModel(u.value)}`
      }

      // Local backend — an openai-completions provider in models.providers.
      const backend = LOCAL_BACKENDS[sel]
      const model = (u.value.model ?? '').trim()
      let apiKey = 'startos' // ignored by keyless backends (Ollama/llama.cpp)
      if (backend.needsKey) {
        const k = await readDependencyApiKey(effects, sel)
        if (!k) {
          throw new Error(
            i18n(
              'vLLM is selected but its API key could not be read from vllm:public/credentials.json. Make sure vLLM is installed and running.',
            ),
          )
        }
        apiKey = k
      }
      const baseUrl = await depApiBaseUrl(effects, sel)
      if (!baseUrl) {
        throw new Error(
          i18n(
            'The selected local backend is not yet reachable on the internal network. Make sure it is installed and running, then run Configure AI Provider again.',
          ),
        )
      }
      const entry: LocalEntry = providers[sel] ?? {
        baseUrl: `${baseUrl}${backend.path}`,
        apiKey,
        api: backend.api,
        timeoutSeconds: 300,
        models: [],
      }
      // Overriding models.providers disables auto-discovery, so the chosen model
      // must be listed explicitly for OpenClaw to treat it as known.
      if (model && !entry.models.some((m) => m.id === model)) {
        entry.models.push({ id: model, name: model, input: ['text'] })
      }
      providers[sel] = entry
      return `${sel}/${model}`
    }

    const primary = await resolve(input.primary as ProviderUnion)
    const fallbackId = await resolve(input.fallback as ProviderUnion)

    await authProfilesJson.write(effects, { profiles })
    await openclawJson.merge(effects, {
      models: { mode: 'merge', providers },
      agents: {
        defaults: {
          model: { primary, fallbacks: fallbackId ? [fallbackId] : [] },
        },
      },
    })

    const keyMissing = await applyEmbeddings(
      effects,
      input.embeddings as EmbeddingUnion,
      profiles,
    )

    // setupDependencies reads the model selection reactively, so writing the
    // config above already updates the local-backend dependency — just restart.
    await effects.restart()

    return {
      version: '1' as const,
      title: i18n('AI provider saved'),
      message: keyMissing
        ? i18n(
            'Saved. Memory embeddings: no API key is saved for this provider, so memory search falls back to keywords until you add one or choose another option.',
          )
        : i18n(
            'Saved. OpenClaw restarts now. If you changed Memory Embeddings, its memory index is rebuilt once; the health skill (or `openclaw memory status`) shows when vector search is ready.',
          ),
      result: null,
    }
  },
)
