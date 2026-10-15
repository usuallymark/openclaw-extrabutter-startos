import { sdk } from '../sdk'
import { externalServicesJson } from '../fileModels/externalServices.json'
import { splitPemCerts, writeMasterPassword } from '../vault'
import {
  EmailConfig,
  importGoogleSignIn,
  parseClientJson,
  parseTokenJson,
} from '../email'

const { InputSpec, Value, Variants } = sdk

// ── Reusable credential-source union ────────────────────────────────────────
// Each secret is either fetched from Vaultwarden (no input) or typed in.
// This mirrors the primary/fallback provider union in configureApiCredentials.
const credentialVariants = (entryName: string, fieldName: string) =>
  Variants.of({
    'from-vaultwarden': {
      name: 'Fetch from Vaultwarden',
      spec: InputSpec.of({}),
    },
    manual: {
      name: 'Enter manually',
      spec: InputSpec.of({
        value: Value.text({
          name: 'Value',
          description: null,
          required: true,
          default: null,
          masked: true,
          placeholder: null,
        }),
      }),
    },
  })

const credentialUnion = (
  label: string,
  entryName: string,
  fieldName: string,
  helpText: string,
) =>
  Value.union({
    name: label,
    description: `${helpText}\n\nWhen "Fetch from Vaultwarden" is selected, OpenClaw reads Vaultwarden item "${entryName}", field "${fieldName}" (${fieldName === 'username' || fieldName === 'password' ? "the login's own username/password" : 'a hidden custom field'}; names are not case-sensitive). This only works if Vaultwarden is enabled above.`,
    default: 'from-vaultwarden',
    variants: credentialVariants(entryName, fieldName),
  })

// "Docs, Photos ,,x" -> "Docs, Photos, x"; blank -> undefined.
const normalizeShares = (raw: unknown): string | undefined => {
  const list = String(raw ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter((x) => x.length > 0)
  return list.length ? Array.from(new Set(list)).join(', ') : undefined
}

const urlField = (label: string, description: string, placeholder: string) =>
  Value.text({
    name: label,
    description,
    required: true,
    default: null,
    masked: false,
    placeholder,
  })

// ── Service variants ────────────────────────────────────────────────────────
// Services that exist as StartOS packages offer Disabled / On this server /
// At an address (startos/localServices.ts). "On this server" asks only for
// the credentials: the address comes from StartOS at every start. The
// "At an address" variant keeps its old id `enabled`, so existing settings
// prefill as before.

const placeNote = (title: string) =>
  `\n\nOn this server: ${title} is installed as a service on this StartOS server. OpenClaw finds it by itself over the server's internal network (no URL, host mapping or certificate needed) and lists ${title} as a dependency.\nAt an address: ${title} runs somewhere else; enter its URL.`

function placedService<Extra extends Record<string, any>>(o: {
  name: string
  title: string
  description: string
  url: ReturnType<typeof urlField>
  extra: Extra
}) {
  return Value.union({
    name: o.name,
    description: o.description + placeNote(o.title),
    default: 'disabled',
    variants: Variants.of({
      disabled: { name: 'Disabled', spec: InputSpec.of({}) },
      local: { name: 'On this server', spec: InputSpec.of(o.extra) },
      enabled: {
        name: 'At an address',
        spec: InputSpec.of({ url: o.url, ...o.extra }),
      },
    }),
  })
}

const vaultwardenService = placedService({
  name: 'Vaultwarden (Password Manager)',
  title: 'Vaultwarden',
  description:
    'Vaultwarden is a self-hosted password manager compatible with Bitwarden clients. When enabled, OpenClaw fetches credentials for other services from it at runtime, so you do not need to enter passwords here.\n\nItems OpenClaw looks for (one item per service, named in lowercase; names are not case-sensitive):\n• email, nas: a Login item with its username and password\n• n8n, trilium, crawl4ai, ntfy: a hidden custom field api_key\n• google: hidden custom fields client_json and token_json\n\nGitHub: https://github.com/dani-garcia/vaultwarden',
  url: urlField(
    'Vaultwarden URL',
    'The base URL of your Vaultwarden server, e.g. https://vaultwarden.yourdomain.local',
    'https://vaultwarden.yourdomain.local',
  ),
  extra: {
    email: Value.text({
      name: 'Account Email',
      description: 'The email address of your Vaultwarden account.',
      required: true,
      default: null,
      masked: false,
      placeholder: 'you@example.com',
      inputmode: 'email',
    }),
    masterPassword: Value.text({
      name: 'Master Password',
      description:
        'Your Vaultwarden master password, used to log in and unlock the vault at every startup. Paste it exactly — it is stored byte-for-byte in a private file (not in the settings file) and read by rbw non-interactively.\n\nLeave blank to keep the password already saved.',
      required: false,
      default: null,
      masked: true,
      placeholder: 'Leave blank to keep the saved password',
    }),
  },
})

const ollamaService = placedService({
  name: 'Ollama (Local AI Models)',
  title: 'Ollama',
  description:
    'Ollama runs large language models locally. Used by OpenClaw for embeddings (nomic-embed-text) and vision analysis (llama3.2-vision).\nGitHub: https://github.com/ollama/ollama',
  url: urlField(
    'Ollama URL',
    'The HTTP URL of your Ollama server, e.g. http://192.168.1.50:11434. Must be reachable from this server on your local network.',
    'http://192.168.1.x:11434',
  ),
  extra: {},
})

const nasService = Value.union({
  name: 'NAS (Network Storage)',
  description:
    'Connect to a NAS via SMB/CIFS. Used by agents to read and write files, photos, and documents on your network storage.',
  default: 'disabled',
  variants: Variants.of({
    disabled: { name: 'Disabled', spec: InputSpec.of({}) },
    enabled: {
      name: 'Enabled',
      spec: InputSpec.of({
        host: urlField(
          'NAS Host',
          'IP address or hostname of your NAS, e.g. 192.168.1.20',
          '192.168.1.x',
        ),
        share: Value.text({
          name: 'Preferred Shares (optional)',
          description:
            'Comma-separated SMB share names the agent should look in first, e.g. "Docs, Photos". Leave blank to let the agent pick. This is a hint, not a restriction: the agent can use every share the NAS account below is allowed to open. To limit access, give that account permissions only on the shares it should use.',
          required: false,
          default: null,
          masked: false,
          placeholder: 'Docs, Photos',
        }),
        username: credentialUnion(
          'Username',
          'nas',
          'username',
          'SMB username for the NAS share.',
        ),
        password: credentialUnion(
          'Password',
          'nas',
          'password',
          'SMB password for the NAS share.',
        ),
      }),
    },
  }),
})

const n8nService = placedService({
  name: 'n8n (Workflow Automation)',
  title: 'n8n',
  description:
    'n8n is an open-source workflow automation tool. Used by agents to trigger and monitor automated workflows.\nGitHub: https://github.com/n8n-io/n8n',
  url: urlField(
    'n8n URL',
    'The URL of your n8n instance, e.g. https://n8n.yourdomain.local',
    'https://n8n.yourdomain.local',
  ),
  extra: {
    apiKey: credentialUnion(
      'API Key',
      'n8n',
      'api_key',
      'n8n API key. Found in n8n → Settings → API → Create API Key.',
    ),
  },
})

// Trilium has no StartOS package (yet): address only.
const triliumService = Value.union({
  name: 'Trilium Notes',
  description:
    'Trilium Notes is a hierarchical note-taking application. Used by agents to create and organize research notes.\nGitHub: https://github.com/TriliumNext/Trilium',
  default: 'disabled',
  variants: Variants.of({
    disabled: { name: 'Disabled', spec: InputSpec.of({}) },
    enabled: {
      name: 'Enabled',
      spec: InputSpec.of({
        url: urlField(
          'Trilium URL',
          'The URL of your Trilium instance including the ETAPI path, e.g. https://trilium.yourdomain.local/etapi',
          'https://trilium.yourdomain.local/etapi',
        ),
        apiKey: credentialUnion(
          'ETAPI Token',
          'trilium',
          'api_key',
          'Trilium ETAPI token. Create it in Trilium → Menu → Options → ETAPI → Create new ETAPI token.',
        ),
      }),
    },
  }),
})

const searxngService = placedService({
  name: 'SearXNG (Web Search)',
  title: 'SearXNG',
  description:
    'SearXNG is a privacy-respecting metasearch engine. Used by agents for web search without tracking. No authentication required; its JSON output must be enabled (it is in the StartOS package), and on this server leave its access password off.\nGitHub: https://github.com/searxng/searxng',
  url: urlField(
    'SearXNG URL',
    'The URL of your SearXNG instance, e.g. https://search.yourdomain.local',
    'https://search.yourdomain.local',
  ),
  extra: {},
})

const crawl4aiService = placedService({
  name: 'Crawl4AI (Web Scraping)',
  title: 'Crawl4AI',
  description:
    'Crawl4AI fetches web pages in a real browser (JavaScript included) and returns clean Markdown agents can read. Used when a plain fetch is not enough. Self-hosted; the API token is required since Crawl4AI 0.9.\nGitHub: https://github.com/unclecode/crawl4ai',
  url: urlField(
    'Crawl4AI URL',
    'The URL of your Crawl4AI server, e.g. https://crawl.yourdomain.local',
    'https://crawl.yourdomain.local',
  ),
  extra: {
    apiKey: credentialUnion(
      'API Token',
      'crawl4ai',
      'api_key',
      'The CRAWL4AI_API_TOKEN your Crawl4AI server was started with.',
    ),
  },
})

const ntfyService = placedService({
  name: 'ntfy (Push Notifications)',
  title: 'ntfy',
  description:
    'ntfy sends push notifications to your phone. Used by agents to report finished work, changes and problems. Self-hosted.\nGitHub: https://github.com/binwiederhier/ntfy',
  url: urlField(
    'ntfy URL',
    'The URL of your ntfy server, e.g. https://ntfy.yourdomain.local',
    'https://ntfy.yourdomain.local',
  ),
  extra: {
    topic: Value.text({
      name: 'Default Topic',
      description:
        'Topic notifications are sent to unless the agent names another one. Letters, digits, "-" and "_" only. Subscribe to it in the ntfy app on your phone.',
      required: true,
      default: null,
      masked: false,
      placeholder: 'openclaw',
      patterns: [
        {
          regex: '^[-_A-Za-z0-9]{1,64}$',
          description:
            'Letters, digits, "-" and "_" only (at most 64 characters).',
        },
      ],
    }),
    apiKey: credentialUnion(
      'Access Token',
      'ntfy',
      'api_key',
      'An ntfy access token (starts with "tk_"). Create one in the ntfy web app → Account → Access tokens, or with `ntfy token add <user>` on the server.',
    ),
  },
})

// ── Email ───────────────────────────────────────────────────────────────────
// One choice, three backends. The two IMAP choices stay plain password forms;
// Calendar/Drive live only under "Google account".

const emailAddress = (description: string, placeholder: string) =>
  Value.text({
    name: 'Email Address',
    description,
    required: true,
    default: null,
    masked: false,
    placeholder,
    inputmode: 'email',
    patterns: [
      {
        regex: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
        description: 'Must be an email address, e.g. you@example.com',
      },
    ],
  })

const displayName = Value.text({
  name: 'Display Name (optional)',
  description:
    'The name shown with the address on sent mail, e.g. "Home Assistant Bot". Leave blank to send with the address only.',
  required: false,
  default: null,
  masked: false,
  placeholder: 'My Agent',
})

const emailPassword = (label: string, helpText: string) =>
  credentialUnion(label, 'email', 'password', helpText)

const securitySelect = (label: string, dflt: 'tls' | 'starttls') =>
  Value.select({
    name: label,
    description:
      'SSL/TLS encrypts from the first byte (usually port 993 for IMAP, 465 for SMTP). STARTTLS connects in plain text and switches to encryption before logging in (usually port 143 for IMAP, 587 for SMTP). Use what your provider documents.',
    default: dflt,
    values: { tls: 'SSL/TLS', starttls: 'STARTTLS' },
  })

const portField = (label: string, dflt: number) =>
  Value.number({
    name: label,
    description: null,
    required: true,
    default: dflt,
    min: 1,
    max: 65535,
    integer: true,
    placeholder: String(dflt),
  })

const hostField = (label: string, placeholder: string) =>
  Value.text({
    name: label,
    description: `Hostname or IP address, e.g. ${placeholder}. For a ".local" name, also add a Custom Host Mapping above.`,
    required: true,
    default: null,
    masked: false,
    placeholder,
  })

const emailService = Value.union({
  name: 'Email',
  description:
    'Lets agents read, search and send email.\n\n• Gmail (app password): the simplest way to use a Gmail address. Mail only.\n• Other IMAP/SMTP provider: any mail service that offers IMAP and SMTP (Fastmail, iCloud, your own server…).\n• Google account: Gmail plus Google Calendar, Drive and other Google services, through a one-time sign-in you make on a computer with a browser.',
  default: 'disabled',
  variants: Variants.of({
    disabled: { name: 'Disabled', spec: InputSpec.of({}) },
    gmail: {
      name: 'Gmail (app password)',
      spec: InputSpec.of({
        address: emailAddress(
          'The Gmail address the agent uses, e.g. you@gmail.com.',
          'you@gmail.com',
        ),
        displayName,
        password: emailPassword(
          'App Password',
          'A Google app password: 16 letters, not your Google password. It requires 2-Step Verification on the account; create one at https://myaccount.google.com/apppasswords (name it "OpenClaw"). Gmail\'s IMAP and SMTP servers are filled in for you.',
        ),
      }),
    },
    imap: {
      name: 'Other IMAP/SMTP provider',
      spec: InputSpec.of({
        address: emailAddress(
          'The address the agent reads and sends as.',
          'you@example.com',
        ),
        displayName,
        imapHost: hostField('IMAP Server', 'imap.example.com'),
        imapPort: portField('IMAP Port', 993),
        imapSecurity: securitySelect('IMAP Encryption', 'tls'),
        smtpHost: hostField('SMTP Server', 'smtp.example.com'),
        smtpPort: portField('SMTP Port', 587),
        smtpSecurity: securitySelect('SMTP Encryption', 'starttls'),
        username: Value.text({
          name: 'Login Name (optional)',
          description:
            'The login for both servers, if it differs from the email address. Leave blank to log in with the address.',
          required: false,
          default: null,
          masked: false,
          placeholder: 'Same as the email address',
        }),
        password: emailPassword(
          'Password',
          'The mailbox password, or an app-specific password if your provider requires one (iCloud, Fastmail, Yahoo, Outlook with 2FA…).',
        ),
      }),
    },
    google: {
      name: 'Google account (Gmail, Calendar, Drive)',
      spec: InputSpec.of({
        address: emailAddress(
          'The Google account the agent uses, e.g. you@gmail.com.',
          'you@gmail.com',
        ),
        signIn: Value.union({
          name: 'Google Sign-in',
          description:
            'The sign-in has two parts, both made once on a computer with a browser (Instructions → Email walks through it):\n\n1. OAuth client: the client_secret_….json of a "Desktop app" client in your own Google Cloud project.\n2. Sign-in token, made with gog on that computer:\n   gog auth credentials ~/Downloads/client_secret_*.json\n   gog auth add you@gmail.com --services gmail,calendar,drive\n   gog auth tokens export you@gmail.com --out token.json\n\nFetch from Vaultwarden: create an item named "google" with two hidden custom fields, client_json and token_json, holding the two files\' contents. They are fetched at every start (requires Vaultwarden above).\nPaste here: stored once, encrypted, on this server only.',
          default: 'from-vaultwarden',
          variants: Variants.of({
            'from-vaultwarden': {
              name: 'Fetch from Vaultwarden',
              spec: InputSpec.of({}),
            },
            manual: {
              name: 'Paste here',
              spec: InputSpec.of({
                clientJson: Value.textarea({
                  name: 'OAuth Client (JSON)',
                  description:
                    'The whole client_secret_….json file. Leave blank to keep the client already saved.',
                  required: false,
                  default: null,
                  minRows: 3,
                  maxRows: 8,
                  placeholder:
                    'Leave blank to keep the saved client. {"installed":{"client_id":"…","client_secret":"…",…}}',
                }),
                tokenJson: Value.textarea({
                  name: 'Sign-in Token (JSON)',
                  description:
                    'The whole token.json written by `gog auth tokens export`. Delete token.json afterwards. Leave blank to keep the sign-in already saved.',
                  required: false,
                  default: null,
                  minRows: 3,
                  maxRows: 8,
                  placeholder:
                    'Leave blank to keep the saved sign-in. {"email":"…","refresh_token":"…",…}',
                }),
              }),
            },
          }),
        }),
      }),
    },
  }),
})

// ── Network: host mappings + custom CA ──────────────────────────────────────

const hostMappings = Value.list(
  sdk.List.obj(
    {
      name: 'Custom Host Mappings',
      description:
        'Hostnames OpenClaw should resolve to a fixed IP address, written to /etc/hosts at startup.\n\nNeeded for any service with a ".local" name (e.g. vaultwarden.home.local). StartOS treats ".local" as mDNS-only (RFC 6762) and will not forward it to your DNS server, so those names never resolve from inside a service even if your router or AdGuard knows them. A mapping here bypasses DNS entirely.\n\nNames ending in .lan, .internal or a real domain normally resolve without this.',
      default: [],
    },
    {
      spec: InputSpec.of({
        hostname: Value.text({
          name: 'Hostname',
          description: 'e.g. vaultwarden.home.local',
          required: true,
          default: null,
          placeholder: 'vaultwarden.home.local',
          patterns: [
            {
              regex:
                '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$',
              description:
                'Must be a valid hostname (letters, digits, hyphens, dots).',
            },
          ],
        }),
        ip: Value.text({
          name: 'IP Address',
          description: 'The LAN IP address of that host, e.g. 192.168.1.50',
          required: true,
          default: null,
          placeholder: '192.168.1.x',
          patterns: [
            {
              regex:
                '^((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)$',
              description: 'Must be an IPv4 address, e.g. 192.168.1.50',
            },
          ],
        }),
      }),
      displayAs: '{{hostname}} → {{ip}}',
      uniqueBy: 'hostname',
    },
  ),
)

const caCert = Value.textarea({
  name: 'Custom CA Certificate',
  description:
    'PEM certificate(s) of an internal certificate authority to trust, e.g. the CA that signs your homelab HTTPS certificates (Vaultwarden, Trilium, n8n…). Paste one or more blocks from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----. Installed into the system trust store at startup; used by rbw, curl and Node.\n\nThis is a public certificate, not a private key. Leave blank if all your services use publicly trusted certificates.',
  required: false,
  default: null,
  minRows: 4,
  maxRows: 12,
  placeholder: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
})

const inputSpec = InputSpec.of({
  hostMappings,
  caCert,
  vaultwarden: vaultwardenService,
  email: emailService,
  ollama: ollamaService,
  nas: nasService,
  n8n: n8nService,
  trilium: triliumService,
  searxng: searxngService,
  crawl4ai: crawl4aiService,
  ntfy: ntfyService,
})

// ── Helpers to map action input <-> stored file shape ───────────────────────

type CredUnion = { selection: string; value: { value?: string | null } }

function credToStored(u: CredUnion | undefined) {
  if (!u) return undefined
  if (u.selection === 'from-vaultwarden') {
    return { source: 'from-vaultwarden' as const }
  }
  return { source: 'manual' as const, value: u.value?.value ?? '' }
}

function credToPrefill(
  stored: { source?: string; value?: string } | undefined,
) {
  if (!stored || stored.source === 'from-vaultwarden') {
    return { selection: 'from-vaultwarden' as const, value: {} }
  }
  return { selection: 'manual' as const, value: { value: stored.value ?? '' } }
}

// "On this server" services: prefill and store. Switching to "On this
// server" keeps the stored URL, so switching back needs no retyping.
type Placed = { enabled?: boolean; location?: string; url?: string }

function placedPrefill<V extends Record<string, unknown>>(
  svc: Placed | undefined,
  value: V,
) {
  if (!svc?.enabled) return { selection: 'disabled' as const, value: {} }
  if (svc.location === 'local') return { selection: 'local' as const, value }
  return {
    selection: 'enabled' as const,
    value: { url: svc.url ?? '', ...value },
  }
}

function placedFromInput<X extends Record<string, unknown>>(
  u: { selection: string; value: any },
  prior: Placed | undefined,
  extra: (v: any) => X,
) {
  if (u.selection === 'local') {
    return {
      enabled: true,
      location: 'local' as const,
      url: prior?.url,
      ...extra(u.value ?? {}),
    }
  }
  if (u.selection === 'enabled') {
    return {
      enabled: true,
      location: 'address' as const,
      url: String(u.value?.url ?? '').trim(),
      ...extra(u.value ?? {}),
    }
  }
  return { enabled: false }
}

function emailPrefill(email: EmailConfig | undefined) {
  const common = {
    address: email?.address ?? '',
    displayName: email?.displayName || null,
  }
  switch (email?.mode) {
    case 'gmail':
      return {
        selection: 'gmail' as const,
        value: { ...common, password: credToPrefill(email.password) },
      }
    case 'imap':
      return {
        selection: 'imap' as const,
        value: {
          ...common,
          imapHost: email.imap?.host ?? '',
          imapPort: email.imap?.port ?? 993,
          imapSecurity: email.imap?.security ?? ('tls' as const),
          smtpHost: email.smtp?.host ?? '',
          smtpPort: email.smtp?.port ?? 587,
          smtpSecurity: email.smtp?.security ?? ('starttls' as const),
          username: email.username || null,
          password: credToPrefill(email.password),
        },
      }
    case 'google':
      // The client and token are never echoed; blank keeps them.
      return {
        selection: 'google' as const,
        value: {
          address: email.address ?? '',
          signIn:
            email.signIn?.source === 'manual'
              ? {
                  selection: 'manual' as const,
                  value: { clientJson: null, tokenJson: null },
                }
              : { selection: 'from-vaultwarden' as const, value: {} },
        },
      }
    default:
      return { selection: 'disabled' as const, value: {} }
  }
}

/** Stored email settings from the form, plus a Google sign-in to import. */
function emailFromInput(e: { selection: string; value: any }) {
  const v = e.value ?? {}
  const address = String(v.address ?? '').trim()
  const displayName = String(v.displayName ?? '').trim() || undefined
  if (e.selection === 'gmail') {
    return {
      stored: {
        mode: 'gmail' as const,
        address,
        displayName,
        password: credToStored(v.password),
      },
      google: null,
    }
  }
  if (e.selection === 'imap') {
    return {
      stored: {
        mode: 'imap' as const,
        address,
        displayName,
        username: String(v.username ?? '').trim() || undefined,
        imap: {
          host: String(v.imapHost).trim(),
          port: Number(v.imapPort),
          security: v.imapSecurity,
        },
        smtp: {
          host: String(v.smtpHost).trim(),
          port: Number(v.smtpPort),
          security: v.smtpSecurity,
        },
        password: credToStored(v.password),
      },
      google: null,
    }
  }
  if (e.selection === 'google') {
    if (v.signIn?.selection !== 'manual') {
      // Fetched from Vaultwarden by the google-sign-in oneshot at start.
      return {
        stored: {
          mode: 'google' as const,
          address,
          signIn: { source: 'from-vaultwarden' as const },
        },
        google: null,
      }
    }
    const pasted = v.signIn.value ?? {}
    const clientText = String(pasted.clientJson ?? '').trim()
    const tokenText = String(pasted.tokenJson ?? '').trim()
    const client = clientText ? parseClientJson(clientText) : null
    const token = tokenText ? parseTokenJson(tokenText) : null
    if (token && token.email.toLowerCase() !== address.toLowerCase()) {
      throw new Error(
        `Sign-in Token: it is for ${token.email}, but the Email Address is ${address}. Export the token for ${address}, or change the address.`,
      )
    }
    return {
      stored: {
        mode: 'google' as const,
        address,
        signIn: { source: 'manual' as const },
      },
      google: { address, client, token: token?.json ?? null },
    }
  }
  return { stored: { mode: 'disabled' as const }, google: null }
}

// ── Action ──────────────────────────────────────────────────────────────────

export const configureExternalServices = sdk.Action.withInput(
  'configure-external-services',

  async ({ effects }) => ({
    name: 'Configure External Services',
    description:
      'Connect OpenClaw to your email and self-hosted tools (Vaultwarden, Ollama, NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy), plus host mappings and a custom CA for internal HTTPS services. Enable only the services you use; a service installed on this server can be chosen "On this server", with no URL. If Vaultwarden is enabled, other services can fetch their credentials from it automatically. Saving restarts OpenClaw to apply changes.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  // Prefill from stored config. Secrets are never echoed back (manual values
  // are re-shown only if already stored as manual; masked in the UI).
  async ({ effects }) => {
    const cfg = await externalServicesJson
      .read()
      .once()
      .catch(() => undefined)

    const vw = cfg?.vaultwarden
    const ollama = cfg?.ollama
    const nas = cfg?.nas
    const n8n = cfg?.n8n
    const trilium = cfg?.trilium
    const searxng = cfg?.searxng
    const crawl4ai = cfg?.crawl4ai
    const ntfy = cfg?.ntfy
    const email = cfg?.email

    return {
      hostMappings: (cfg?.hostMappings ?? []).map((m) => ({
        hostname: m.hostname,
        ip: m.ip,
      })),
      caCert: cfg?.caCert ?? null,
      vaultwarden: placedPrefill(vw, {
        email: vw?.email ?? '',
        masterPassword: null, // never echo secrets
      }),
      email: emailPrefill(email),
      ollama: placedPrefill(ollama, {}),
      nas: nas?.enabled
        ? {
            selection: 'enabled' as const,
            value: {
              host: nas.host ?? '',
              share: nas.share || null,
              username: credToPrefill(nas.username),
              password: credToPrefill(nas.password),
            },
          }
        : { selection: 'disabled' as const, value: {} },
      n8n: placedPrefill(n8n, { apiKey: credToPrefill(n8n?.apiKey) }),
      trilium: trilium?.enabled
        ? {
            selection: 'enabled' as const,
            value: {
              url: trilium.url ?? '',
              apiKey: credToPrefill(trilium.apiKey),
            },
          }
        : { selection: 'disabled' as const, value: {} },
      searxng: placedPrefill(searxng, {}),
      crawl4ai: placedPrefill(crawl4ai, {
        apiKey: credToPrefill(crawl4ai?.apiKey),
      }),
      ntfy: placedPrefill(ntfy, {
        topic: ntfy?.topic ?? '',
        apiKey: credToPrefill(ntfy?.apiKey),
      }),
    }
  },

  async ({ effects, input }) => {
    const i = input as any

    const hostMappings = (
      (i.hostMappings ?? []) as {
        hostname: string
        ip: string
      }[]
    ).map((m) => ({ hostname: m.hostname.trim(), ip: m.ip.trim() }))

    const caText: string = (i.caCert ?? '').trim()
    if (caText && splitPemCerts(caText).length === 0) {
      throw new Error(
        'Custom CA Certificate: no PEM certificate found. Paste the full block including the -----BEGIN CERTIFICATE----- and -----END CERTIFICATE----- lines.',
      )
    }
    const caCert = caText ? splitPemCerts(caText).join('\n') + '\n' : undefined

    // Prior settings: "On this server" keeps the stored URL for switching back.
    const prior = await externalServicesJson
      .read()
      .once()
      .catch(() => undefined)

    // The master password is never stored in the settings file. A non-empty
    // value is written byte-exact to rbw/.credentials; blank keeps the
    // existing file untouched.
    const vaultwarden = placedFromInput(
      i.vaultwarden,
      prior?.vaultwarden,
      (v) => ({ email: String(v.email ?? '').trim() }),
    )
    const newMasterPassword: string =
      i.vaultwarden.selection !== 'disabled'
        ? (i.vaultwarden.value.masterPassword ?? '')
        : ''

    const ollama = placedFromInput(i.ollama, prior?.ollama, () => ({}))

    const nas =
      i.nas.selection === 'enabled'
        ? {
            enabled: true,
            host: i.nas.value.host,
            share: normalizeShares(i.nas.value.share),
            username: credToStored(i.nas.value.username),
            password: credToStored(i.nas.value.password),
          }
        : { enabled: false }

    const n8n = placedFromInput(i.n8n, prior?.n8n, (v) => ({
      apiKey: credToStored(v.apiKey),
    }))

    const trilium =
      i.trilium.selection === 'enabled'
        ? {
            enabled: true,
            url: i.trilium.value.url,
            apiKey: credToStored(i.trilium.value.apiKey),
          }
        : { enabled: false }

    const searxng = placedFromInput(i.searxng, prior?.searxng, () => ({}))

    const crawl4ai = placedFromInput(i.crawl4ai, prior?.crawl4ai, (v) => ({
      apiKey: credToStored(v.apiKey),
    }))

    const ntfy = placedFromInput(i.ntfy, prior?.ntfy, (v) => ({
      topic: String(v.topic ?? '').trim(),
      apiKey: credToStored(v.apiKey),
    }))

    // Validates the pasted Google client/token before anything is saved.
    const email = emailFromInput(i.email)

    if (newMasterPassword) {
      await writeMasterPassword(newMasterPassword)
    }

    if (email.google && (email.google.client || email.google.token)) {
      await importGoogleSignIn(
        effects,
        email.google.address,
        email.google.client,
        email.google.token,
      )
    }

    await externalServicesJson.write(effects, {
      hostMappings,
      caCert,
      vaultwarden,
      email: email.stored,
      ollama,
      nas,
      n8n,
      trilium,
      searxng,
      crawl4ai,
      ntfy,
    } as any)

    await effects.restart()

    return {
      version: '1' as const,
      title: 'External Services Configured',
      message:
        'Settings saved. OpenClaw is restarting to apply the new configuration.',
      result: null,
    }
  },
)
