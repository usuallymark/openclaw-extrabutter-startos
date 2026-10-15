import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { externalServicesJson } from './fileModels/externalServices.json'

// "On this server": an external service that runs as a StartOS package on the
// same server is reached over the internal bridge (plain HTTP that never
// leaves the server), at an address StartOS hands out. No URL, host mapping
// or CA is needed, and moving a service onto the server is a setting change.
//
// Each row comes from the service's own package (startos/utils.ts and
// interfaces.ts): the MultiHost id and the internal port of its HTTP
// binding. versionRange starts at the package's first StartOS 0.4 release;
// healthChecks names the daemon whose readiness means "serving".
// To add a service: one row here (and its key in LocalKey's users).
export const LOCAL_SERVICES = {
  vaultwarden: {
    packageId: 'vaultwarden',
    title: 'Vaultwarden',
    hostId: 'main',
    port: 80,
    versionRange: '>=1.36.0:3',
    healthChecks: ['primary'],
    icon: 'https://raw.githubusercontent.com/Start9Labs/vaultwarden-startos/master/icon.svg',
  },
  ollama: {
    packageId: 'ollama',
    title: 'Ollama',
    hostId: 'api-multi',
    port: 11434,
    versionRange: '>=0.31.2:2',
    healthChecks: ['primary'],
    icon: 'https://raw.githubusercontent.com/Start9Labs/ollama-startos/master/icon.svg',
  },
  n8n: {
    packageId: 'n8n',
    title: 'n8n',
    hostId: 'ui-multi',
    port: 5678,
    versionRange: '>=2.42.5:1',
    healthChecks: ['primary'],
    icon: 'https://raw.githubusercontent.com/Start9-Community/n8n-startos/master/icon.svg',
  },
  searxng: {
    packageId: 'searxng',
    title: 'SearXNG',
    hostId: 'main',
    port: 80,
    versionRange: '>=2026.7.13:0',
    healthChecks: ['searxng'],
    icon: 'https://raw.githubusercontent.com/Start9Labs/searxng-startos/master/icon.svg',
  },
  crawl4ai: {
    packageId: 'crawl4ai',
    title: 'Crawl4AI',
    hostId: 'web',
    port: 11235,
    versionRange: '>=0.9.4:1',
    healthChecks: ['crawl4ai'],
    icon: 'https://raw.githubusercontent.com/Start9-Community/crawl4ai-startos/main/icon.svg',
  },
  ntfy: {
    packageId: 'ntfy',
    title: 'ntfy',
    hostId: 'ui-multi',
    port: 80,
    versionRange: '>=2.28.0:1',
    healthChecks: ['primary'],
    icon: 'https://raw.githubusercontent.com/Start9Labs/ntfy-startos/master/icon.svg',
  },
} as const

export type LocalKey = keyof typeof LOCAL_SERVICES
export const LOCAL_KEYS = Object.keys(LOCAL_SERVICES) as LocalKey[]

type Svc = { enabled?: boolean; location?: string; url?: string } | undefined

/** Is this service set to "On this server"? */
export const isLocal = (svc: Svc) => !!svc?.enabled && svc.location === 'local'

/** Watchable: is `key` enabled and set to "On this server"? (dependencies) */
export const localChosen = (effects: T.Effects, key: LocalKey) =>
  externalServicesJson
    .read((c) => isLocal(c?.[key] as Svc))
    .const(effects)
    .then((v) => !!v)

/**
 * The external-services settings with every "On this server" service's
 * `url` replaced by its bridge URL, plus the services chosen as local whose
 * package is not installed (their `url` is removed, so nothing uses them;
 * the health checks say why). Reactive: main re-runs when an address
 * appears, disappears or changes (e.g. after a reinstall).
 */
export async function resolveLocalServices<E extends Record<string, any>>(
  effects: T.Effects,
  ext: E | null | undefined,
): Promise<{
  ext: E | null | undefined
  missing: Partial<Record<LocalKey, string>>
}> {
  const missing: Partial<Record<LocalKey, string>> = {}
  if (!ext) return { ext, missing }
  const out: Record<string, any> = { ...ext }
  for (const key of LOCAL_KEYS) {
    const svc = out[key] as Svc
    if (!isLocal(svc)) continue
    const s = LOCAL_SERVICES[key]
    const addr = await sdk.host
      .getBridgeAddress(effects, {
        packageId: s.packageId,
        hostId: s.hostId,
        internalPort: s.port,
        ssl: false,
      })
      .const()
    if (addr) {
      out[key] = { ...svc, url: `http://${addr}` }
    } else {
      out[key] = { ...svc, url: undefined }
      missing[key] = s.title
    }
  }
  return { ext: out as E, missing }
}

/** Health-check text for a service chosen as local whose package is absent. */
export const notInstalledMessage = (title: string) =>
  `${title} on this server is chosen, but ${title} is not installed (or not set up) on this server. Install ${title} from the Marketplace, or choose "At an address" in Configure External Services.`
