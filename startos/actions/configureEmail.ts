import { sdk } from '../sdk'
import { openclawJson } from '../fileModels/openclaw.json'
import {
  EmailSettings,
  emailSettingsJson,
} from '../fileModels/emailSettings.json'
import {
  EmailConfig,
  importGoogleSignIn,
  parseClientJson,
  parseTokenJson,
} from '../email'
import { sendingOf, writeEmailSettings } from '../mailService'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'
import {
  credToPrefill,
  credToStored,
  credentialUnion,
} from './configureExternalServices'

const { InputSpec, Value, Variants } = sdk

// Configure Email (since 2026.10.1:8): the account (moved here from
// Configure External Services), the email agent, and (since :10) the
// sending rules. Settings are stored in /data/.openclaw-mail/settings.json,
// a root-only file the agents cannot read; the rules also go to rules.json
// beside it, which the mail service reads before every send (mailService.ts).

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
  name: 'Account',
  description:
    'The mailbox the email agent uses.\n\n• Gmail (app password): the simplest way to use a Gmail address.\n• Other IMAP/SMTP provider: any mail service that offers IMAP and SMTP (Fastmail, iCloud, your own server…).\n\nWith these two, mail is handled by a separate mail service and a separate email agent: the agent that reads mail has no shell and no passwords, it sends only under your rules (Sending, below), and your main agent never reads mail itself (it asks the email agent).\n\n• Google account: Gmail plus Google Calendar, Drive and other Google services, through a one-time sign-in you make on a computer with a browser. Not yet isolated: the main agent uses this account directly, as before.',
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

// ── Stored settings <-> form ───────────────────────────────────────────────

export function emailPrefill(email: EmailConfig | undefined) {
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
export function emailFromInput(e: { selection: string; value: any }) {
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

// ── Email agent ─────────────────────────────────────────────────────────────

const EMAIL_RE = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const agentModel = Value.dynamicSelect(async () => {
  const cfg = ((await openclawJson
    .read()
    .once()
    .catch(() => undefined)) ?? {}) as any
  const main = cfg?.agents?.defaults?.model?.primary
  const current = (await emailSettingsJson
    .read((s) => s.agent?.model)
    .once()
    .catch(() => undefined)) as string | undefined
  return {
    name: 'Email Agent Model',
    description:
      'The model that reads your mail. Mail is written by strangers and may try to trick the model, so a strong cloud model is the safer choice. A local model works, but resists tricks less well (the agent still cannot run commands, read passwords or send).',
    default: 'default',
    values: {
      default: 'Same as the main agent' + (main ? ` (${main})` : ''),
      ...(await agentModelChoices(
        {
          anthropic: ANTHROPIC_MODELS,
          openai: OPENAI_MODELS,
          google: GEMINI_MODELS,
          xai: GROK_MODELS,
        },
        cfg?.models?.providers?.[OLLAMA_SERVER_ID]?.baseUrl,
        current && current !== 'default' ? [current] : [],
      )),
    },
  }
})

const trustedSenders = Value.list(
  sdk.List.text(
    {
      name: 'Trusted Senders',
      description:
        "Addresses whose attachments may be copied into the workspace (folder mail-inbox), so the main agent can open the files. Only when the receiving mail server confirms the message really came from that address (SPF/DKIM/DMARC). Attachments from everyone else stay in the mailbox; the email agent can still read their text. Typically your own addresses and your family's.",
      default: [],
      maxLength: 50,
    },
    {
      placeholder: 'you@example.com',
      inputmode: 'email',
      patterns: [
        {
          regex: EMAIL_RE,
          description: 'An email address, e.g. you@example.com',
        },
      ],
    },
  ),
)

const extraInstructions = Value.textarea({
  name: 'Extra Instructions (optional)',
  description:
    'Added to the email agent\'s instructions, e.g. "Mail from the school is always important" or "Newsletters are never important". They cannot loosen its rules.',
  required: false,
  default: null,
  minRows: 2,
  maxRows: 8,
  placeholder: 'Mail from the school is always important.',
})

// ── Sending ─────────────────────────────────────────────────────────────────

const ADDR_OR_DOMAIN_RE =
  '^([^@\\s]+@[^@\\s]+\\.[^@\\s]+|@[^@\\s]+\\.[^@\\s]+)$'

const addressList = (name: string, description: string) =>
  Value.list(
    sdk.List.text(
      { name, description, default: [], maxLength: 100 },
      {
        placeholder: 'sam@example.com or @example.com',
        inputmode: 'email',
        patterns: [
          {
            regex: ADDR_OR_DOMAIN_RE,
            description:
              'An address (sam@example.com) or a whole domain (@example.com)',
          },
        ],
      },
    ),
  )

const limit = (name: string, description: string, dflt: number, max: number) =>
  Value.number({
    name,
    description,
    required: true,
    default: dflt,
    min: 1,
    max,
    integer: true,
    placeholder: String(dflt),
  })

const sending = Value.object(
  {
    name: 'Sending',
    description:
      'What happens when the email agent is asked to send a draft (Gmail and IMAP only). Every recipient (To, Cc and Bcc) is checked: anyone on Never Send To → refused; a forward, any attachment, or a limit reached → waits for your approval; everyone on Send Automatically To (or a Trusted Sender, when that switch is on) → sent; otherwise Anyone Else decides. Mail waiting for approval appears as a task and under Actions → Review Outgoing Mail; it expires after 3 days.',
  },
  InputSpec.of({
    level: Value.select({
      name: 'Sending',
      description:
        'Off: the email agent reads and files mail only (no drafts). Drafts only: it saves drafts and you send them from your mail app. Send by rules: it can send, following the rules below.',
      default: 'drafts',
      values: {
        off: 'Off (read only)',
        drafts: 'Drafts only',
        rules: 'Send by rules',
      },
    }),
    includeTrusted: Value.toggle({
      name: 'Send Automatically to Trusted Senders',
      description:
        "The Trusted Senders above also count as Send Automatically To, so you don't list your own and your family's addresses twice. Turn off to keep the two lists separate.",
      default: true,
    }),
    autoTo: addressList(
      'Send Automatically To',
      'More addresses (or whole domains, written @example.com) the email agent may send to without asking you. A domain means that domain only, not its subdomains.',
    ),
    neverTo: addressList(
      'Never Send To',
      'Addresses or domains the email agent must never send to. A message with any of these among its recipients is refused, even if you would approve it.',
    ),
    others: Value.select({
      name: 'Anyone Else',
      description:
        'Recipients on neither list. Ask me: the message waits for your approval (recommended). Block: refused. Send automatically: sent without asking. Not recommended: mail is written by strangers and may trick the agent into writing to someone; with this setting nothing stops it.',
      default: 'ask',
      values: {
        ask: 'Ask me',
        block: 'Block',
        auto: 'Send automatically (not recommended)',
      },
    }),
    perHour: limit(
      'Limit per Hour',
      'Messages sent in the last hour beyond this wait for your approval.',
      10,
      500,
    ),
    perDay: limit(
      'Limit per Day',
      'Messages sent in the last 24 hours beyond this wait for your approval.',
      30,
      2000,
    ),
    maxRecipients: limit(
      'Recipients per Message',
      'A message to more recipients than this (To, Cc and Bcc together) waits for your approval.',
      10,
      100,
    ),
  }),
)

const inputSpec = InputSpec.of({
  account: emailService,
  agentModel,
  trustedSenders,
  extraInstructions,
  sending,
})

// ── Action ──────────────────────────────────────────────────────────────────

const cleanList = (xs: unknown): string[] =>
  Array.from(
    new Set(
      ((xs ?? []) as string[])
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean),
    ),
  )

export const configureEmail = sdk.Action.withInput(
  'configure-email',

  async () => ({
    name: 'Configure Email',
    description:
      'Connect a mailbox and set up the email agent: the only agent that reads mail. It has no shell and no passwords; your main agent asks it about your mail. It can read, search, organise (mark read, flag, move, archive; never delete), write drafts, and send under the rules you set here. Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const s = await emailSettingsJson
      .read()
      .once()
      .catch(() => null)
    return {
      account: emailPrefill(s?.account as EmailConfig | undefined),
      agentModel: s?.agent?.model || 'default',
      trustedSenders: s?.agent?.trustedSenders ?? [],
      extraInstructions: s?.agent?.extraInstructions || null,
      sending: sendingOf(s),
    } as any
  },

  async ({ effects, input }) => {
    const i = input as any
    // Validates a pasted Google client/token before anything is saved.
    const email = emailFromInput(i.account)
    const trusted: string[] = Array.from(
      new Set(
        ((i.trustedSenders ?? []) as string[])
          .map((t) => String(t).trim().toLowerCase())
          .filter(Boolean),
      ),
    )
    if (email.google && (email.google.client || email.google.token)) {
      await importGoogleSignIn(
        effects,
        email.google.address,
        email.google.client,
        email.google.token,
      )
    }
    const prior = await emailSettingsJson
      .read()
      .once()
      .catch(() => null)
    const settings: EmailSettings = {
      ...(prior ?? {}),
      account: email.stored as any,
      agent: {
        ...(prior?.agent ?? {}),
        model: String(i.agentModel || 'default'),
        trustedSenders: trusted,
        extraInstructions:
          String(i.extraInstructions ?? '').trim() || undefined,
      },
      sending: {
        level: i.sending?.level ?? 'drafts',
        autoTo: cleanList(i.sending?.autoTo),
        includeTrusted: i.sending?.includeTrusted !== false,
        neverTo: cleanList(i.sending?.neverTo),
        others: i.sending?.others ?? 'ask',
        perHour: Number(i.sending?.perHour ?? 10),
        perDay: Number(i.sending?.perDay ?? 30),
        maxRecipients: Number(i.sending?.maxRecipients ?? 10),
      },
    } as EmailSettings
    await writeEmailSettings(effects, settings)
    await effects.restart()
    return {
      version: '1' as const,
      title: 'Email Configured',
      message:
        'Settings saved. OpenClaw is restarting. With Gmail or IMAP, the mail service starts on its own; its state is shown as "Mail Service" on the service page.' +
        (i.sending?.others === 'auto' && i.sending?.level === 'rules'
          ? ' Note: Anyone Else is set to Send automatically, so the email agent can send to any address without asking you.'
          : ''),
      result: null,
    }
  },
)
