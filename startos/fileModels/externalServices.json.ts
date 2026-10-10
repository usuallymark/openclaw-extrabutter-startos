import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// A credential is either fetched from Vaultwarden at runtime or entered manually.
const credentialShape = z
  .looseObject({
    source: z.enum(['from-vaultwarden', 'manual']).catch('manual'),
    value: z.string().optional().catch(undefined),
  })
  .catch({ source: 'manual' as const, value: undefined })

const vaultwardenShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    url: z.string().optional().catch(undefined),
    email: z.string().optional().catch(undefined),
    // Legacy (<= 2026.9.4:1). No longer written: rbw cannot log in with an
    // API key, and the master password now lives only in rbw/.credentials.
    // Still read once so an existing install can seed .credentials.
    apiKey: z.string().optional().catch(undefined),
    masterPassword: z.string().optional().catch(undefined),
  })
  .catch({ enabled: false })

const hostMappingShape = z.looseObject({
  hostname: z.string(),
  ip: z.string(),
})

const urlOnlyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    url: z.string().optional().catch(undefined),
  })
  .catch({ enabled: false })

const urlWithKeyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    url: z.string().optional().catch(undefined),
    apiKey: credentialShape.optional().catch(undefined),
  })
  .catch({ enabled: false })

const ntfyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    url: z.string().optional().catch(undefined),
    topic: z.string().optional().catch(undefined),
    apiKey: credentialShape.optional().catch(undefined),
  })
  .catch({ enabled: false })

const nasShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    host: z.string().optional().catch(undefined),
    share: z.string().optional().catch(undefined),
    username: credentialShape.optional().catch(undefined),
    password: credentialShape.optional().catch(undefined),
  })
  .catch({ enabled: false })

const shape = z.looseObject({
  hostMappings: z.array(hostMappingShape).catch([]),
  caCert: z.string().optional().catch(undefined),
  vaultwarden: vaultwardenShape.catch({ enabled: false }),
  ollama: urlOnlyShape.catch({ enabled: false }),
  nas: nasShape.catch({ enabled: false }),
  n8n: urlWithKeyShape.catch({ enabled: false }),
  trilium: urlWithKeyShape.catch({ enabled: false }),
  searxng: urlOnlyShape.catch({ enabled: false }),
  // Firecrawl (<= 2026.9.4:9) was replaced by Crawl4AI and Stirling PDF
  // (<= 2026.9.4:19) by the built-in pdf skill; an old `firecrawl` or
  // `stirling` key in the file is ignored and dropped on the next save.
  crawl4ai: urlWithKeyShape.catch({ enabled: false }),
  ntfy: ntfyShape.catch({ enabled: false }),
})

export const externalServicesJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '.openclaw/external-services.json' },
  shape,
)
