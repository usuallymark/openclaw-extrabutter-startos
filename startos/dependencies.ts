import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { openclawJson } from './fileModels/openclaw.json'
import { SIMPLEX_BRIDGE_ID, simplexEnabled } from './simplex'
import { LOCAL_SERVICES, LocalKey, localChosen } from './localServices'

// Every dependency is optional and enabled only while it is in use. Each
// `enabled` reads reactively, so a dependency follows the model selection even
// when OpenClaw changes it itself (e.g. /model in chat).

/** Providers in use (primary + fallbacks), by their `provider/...` prefix. */
async function providersInUse(effects: T.Effects) {
  const model = await openclawJson
    .read((c) => c.agents?.defaults?.model)
    .const(effects)
  return new Set(
    [model?.primary, ...(model?.fallbacks ?? [])]
      .filter((r): r is string => !!r)
      .map((r) => r.split('/')[0]),
  )
}

// A local inference backend, required (running and healthy) only while a
// model on it is the primary or a fallback. The id is also the provider
// prefix Configure AI Provider writes.
const localBackend = <const Id extends string>(
  id: Id,
  title: string,
  icon: string,
  description: string,
  versionRange: string,
) =>
  sdk.Dependency.optional(id, {
    description: { en_US: description },
    metadata: { title: { en_US: title }, icon },
    versionRange,
    kind: 'running',
    healthChecks: ['primary'],
    enabled: async ({ effects }) =>
      (await providersInUse(effects)).has(id) ||
      // Ollama also serves embeddings/vision when Configure External Services
      // has it "On this server".
      (id === 'ollama' && (await localChosen(effects, 'ollama'))),
  })

// A service from Configure External Services set to "On this server":
// required (running and healthy) only while that choice is made.
const localService = (
  key: Exclude<LocalKey, 'ollama'>,
  description: string,
) => {
  const s = LOCAL_SERVICES[key]
  return sdk.Dependency.optional(s.packageId, {
    description: { en_US: description },
    metadata: { title: { en_US: s.title }, icon: s.icon },
    versionRange: s.versionRange,
    kind: 'running',
    healthChecks: [...s.healthChecks],
    enabled: ({ effects }) => localChosen(effects, key),
  })
}

export const dependencies = sdk.Dependencies.of()
  .addDependency(
    localBackend(
      'ollama',
      'Ollama',
      'https://raw.githubusercontent.com/Start9Labs/ollama-startos/master/icon.svg',
      'Optional: run local LLMs with Ollama. Select it as your backend in the Configure AI Provider action, or choose "On this server" for Ollama in Configure External Services (embeddings and vision).',
      '>=0.31.2:2',
    ),
  )
  .addDependency(
    localBackend(
      'vllm',
      'vLLM',
      'https://raw.githubusercontent.com/Start9Labs/vllm-startos/master/icon.svg',
      "Optional: serve local LLMs through vLLM's OpenAI-compatible API. Select it as your backend in the Configure AI Provider action.",
      '>=0.23.1-rc.0:13',
    ),
  )
  .addDependency(
    localBackend(
      'llama-cpp',
      'llama.cpp',
      'https://raw.githubusercontent.com/Start9Labs/llama-cpp-startos/master/icon.png',
      'Optional: run local GGUF models with llama.cpp. Select it as your backend in the Configure AI Provider action.',
      '>=1.0.9994:1',
    ),
  )
  .addDependency(
    sdk.Dependency.optional(SIMPLEX_BRIDGE_ID, {
      description: {
        en_US:
          'Optional: exchange files over SimpleX. Enable it in the Configure SimpleX action to mount the bridge file-exchange directories.',
      },
      metadata: {
        title: { en_US: 'SimpleX Websocket Bridge' },
        icon: 'https://raw.githubusercontent.com/Start9-Community/simplex-websocket-bridge-startos/master/icon.svg',
      },
      versionRange: '>=0.3.0:0',
      kind: 'running',
      healthChecks: ['websocket'],
      enabled: ({ effects }) => simplexEnabled(effects),
    }),
  )
  .addDependency(
    localService(
      'vaultwarden',
      'Optional: keep the credentials OpenClaw uses in Vaultwarden on this server. Choose "On this server" for Vaultwarden in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'n8n',
      'Optional: let agents trigger n8n workflows on this server. Choose "On this server" for n8n in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'searxng',
      'Optional: private web search through SearXNG on this server. Choose "On this server" for SearXNG in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'crawl4ai',
      'Optional: fetch web pages in a real browser with Crawl4AI on this server. Choose "On this server" for Crawl4AI in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'trilium',
      'Optional: let agents create and search notes in Trilium Notes on this server. Choose "On this server" for Trilium in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'ntfy',
      'Optional: push notifications through ntfy on this server. Choose "On this server" for ntfy in Configure External Services.',
    ),
  )
  .addDependency(
    localService(
      'gitea',
      'Optional: let agents create, commit to and push their own git repositories on Gitea on this server. Choose "On this server" for Gitea in Configure External Services.',
    ),
  )
