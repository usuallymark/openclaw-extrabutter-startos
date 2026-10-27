import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { emailModes } from './externalServices.json'

// Configure Email (since 2026.10.1:8). Kept in /data/.openclaw-mail, a
// folder the gateway user (node) cannot enter: the chown oneshot skips it,
// and the mail launcher sets it to root:openclaw-mail 0710 at every start.
// The file itself is root's (0600), so a manually entered password is out
// of the agents' reach. Before 2026.10.1:8 these settings were the `email`
// section of external-services.json (initEmailSettings moves them).

export const MAIL_ROOT = '/data/.openclaw-mail'
export const MAIL_ROOT_SUBPATH = '.openclaw-mail'
export const EMAIL_SETTINGS_SUBPATH = `${MAIL_ROOT_SUBPATH}/settings.json`

const credentialShape = z
  .looseObject({
    source: z.enum(['from-vaultwarden', 'manual']).catch('from-vaultwarden'),
    value: z.string().optional().catch(undefined),
  })
  .catch({ source: 'from-vaultwarden' as const, value: undefined })

const mailServerShape = z
  .looseObject({
    host: z.string().optional().catch(undefined),
    port: z.number().optional().catch(undefined),
    security: z.enum(['tls', 'starttls']).catch('tls'),
  })
  .catch({ security: 'tls' as const })

const accountShape = z
  .looseObject({
    mode: z.enum(emailModes).catch('disabled'),
    address: z.string().optional().catch(undefined),
    displayName: z.string().optional().catch(undefined),
    username: z.string().optional().catch(undefined),
    imap: mailServerShape.optional().catch(undefined),
    smtp: mailServerShape.optional().catch(undefined),
    password: credentialShape.optional().catch(undefined),
    signIn: credentialShape.optional().catch(undefined),
  })
  .catch({ mode: 'disabled' as const })

const agentShape = z
  .looseObject({
    // "default" = the main agent's model.
    model: z.string().catch('default'),
    trustedSenders: z.array(z.string()).catch([]),
    extraInstructions: z.string().optional().catch(undefined),
  })
  .catch({ model: 'default', trustedSenders: [] })

const shape = z.looseObject({
  account: accountShape,
  agent: agentShape,
})

export type EmailSettings = z.infer<typeof shape>

export const emailSettingsJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: EMAIL_SETTINGS_SUBPATH },
  shape,
)
