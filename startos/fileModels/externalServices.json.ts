import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// A credential is either fetched from Vaultwarden at runtime or entered manually.
const credentialShape = z
  .looseObject({
    source: z.enum(['from-vaultwarden', 'manual']).catch('manual'),
    value: z.string().optional().catch(undefined),
  })
  .catch({ source: 'manual' as const, value: undefined })

// Where a service runs (since 2026.10.1:3): "address" = at the URL below;
// "local" = as a StartOS package on this server, reached over the internal
// bridge (startos/localServices.ts). Older files have no `location` and stay
// on "address". The URL is kept while "local" is chosen, for switching back.
const locationShape = z.enum(['address', 'local']).catch('address')
const OFF = { enabled: false, location: 'address' as const }

const vaultwardenShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    location: locationShape,
    url: z.string().optional().catch(undefined),
    email: z.string().optional().catch(undefined),
    // Legacy (<= 2026.9.4:1). No longer written: rbw cannot log in with an
    // API key, and the master password now lives only in rbw/.credentials.
    // Still read once so an existing install can seed .credentials.
    apiKey: z.string().optional().catch(undefined),
    masterPassword: z.string().optional().catch(undefined),
  })
  .catch(OFF)

const hostMappingShape = z.looseObject({
  hostname: z.string(),
  ip: z.string(),
})

const urlOnlyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    location: locationShape,
    url: z.string().optional().catch(undefined),
  })
  .catch(OFF)

const urlWithKeyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    location: locationShape,
    url: z.string().optional().catch(undefined),
    apiKey: credentialShape.optional().catch(undefined),
  })
  .catch(OFF)

const ntfyShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    location: locationShape,
    url: z.string().optional().catch(undefined),
    topic: z.string().optional().catch(undefined),
    apiKey: credentialShape.optional().catch(undefined),
  })
  .catch(OFF)

const nasShape = z
  .looseObject({
    enabled: z.boolean().catch(false),
    host: z.string().optional().catch(undefined),
    share: z.string().optional().catch(undefined),
    username: credentialShape.optional().catch(undefined),
    password: credentialShape.optional().catch(undefined),
  })
  .catch({ enabled: false })

// Email (since 2026.10.1:1). `mode` picks the backend:
// - gmail:  himalaya against Gmail's IMAP/SMTP with an app password
// - imap:   himalaya against any IMAP/SMTP provider
// - google: gog with an imported OAuth sign-in (Gmail, Calendar, Drive …).
//   Its OAuth client and refresh token live in gog's encrypted keyring
//   under .openclaw/gog, never in this file.
const mailServerShape = z
  .looseObject({
    host: z.string().optional().catch(undefined),
    port: z.number().optional().catch(undefined),
    security: z.enum(['tls', 'starttls']).catch('tls'),
  })
  .catch({ security: 'tls' as const })

export const emailModes = ['disabled', 'gmail', 'imap', 'google'] as const

const emailShape = z
  .looseObject({
    mode: z.enum(emailModes).catch('disabled'),
    address: z.string().optional().catch(undefined),
    displayName: z.string().optional().catch(undefined),
    username: z.string().optional().catch(undefined),
    imap: mailServerShape.optional().catch(undefined),
    smtp: mailServerShape.optional().catch(undefined),
    password: credentialShape.optional().catch(undefined),
    // google: where the OAuth client + token come from. from-vaultwarden:
    // fetched at every start (item "google", fields client_json and
    // token_json) and loaded into gog's keyring; manual: pasted once,
    // kept only in gog's keyring. `value` is never used here.
    signIn: credentialShape.optional().catch(undefined),
  })
  .catch({ mode: 'disabled' as const })

const shape = z.looseObject({
  hostMappings: z.array(hostMappingShape).catch([]),
  caCert: z.string().optional().catch(undefined),
  vaultwarden: vaultwardenShape.catch(OFF),
  ollama: urlOnlyShape.catch(OFF),
  nas: nasShape.catch({ enabled: false }),
  n8n: urlWithKeyShape.catch(OFF),
  trilium: urlWithKeyShape.catch(OFF),
  searxng: urlOnlyShape.catch(OFF),
  // Firecrawl (<= 2026.9.4:9) was replaced by Crawl4AI and Stirling PDF
  // (<= 2026.9.4:19) by the built-in pdf skill; an old `firecrawl` or
  // `stirling` key in the file is ignored and dropped on the next save.
  crawl4ai: urlWithKeyShape.catch(OFF),
  ntfy: ntfyShape.catch(OFF),
  email: emailShape.catch({ mode: 'disabled' as const }),
})

export const externalServicesJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '.openclaw/external-services.json' },
  shape,
)
