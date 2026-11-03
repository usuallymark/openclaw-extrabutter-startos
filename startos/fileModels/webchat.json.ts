import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { linkSafe } from '../noLinks'

// Webchat configuration, written by Configure Webchat and read by the webchat
// server (/opt/webchat/server.mjs). PINs are stored only as scrypt hashes.
export const WEBCHAT_ACCENTS = [
  'gold',
  'teal',
  'violet',
  'rose',
  'blue',
  'green',
] as const

const profileShape = z.looseObject({
  id: z.string(),
  name: z.string().catch(''),
  accent: z.enum(WEBCHAT_ACCENTS).catch('gold'),
  greeting: z.string().catch(''),
  presets: z.array(z.string()).catch([]),
  pinHash: z.string().nullable().optional().catch(null),
  pinVersion: z.number().catch(0),
})

const shape = z.looseObject({
  enabled: z.boolean().catch(false),
  appName: z.string().catch('OpenClaw'),
  rememberDays: z.number().catch(90),
  profiles: z.array(profileShape).catch([]),
})

export type WebchatProfile = z.infer<typeof profileShape>

const webchatJsonRaw = FileHelper.json(
  { base: sdk.volumes.main, subpath: '.openclaw/webchat/config.json' },
  shape,
)

// Writes clear any link on the way first (noLinks.ts): the folder is the
// gateway user's.
export const webchatJson = linkSafe(
  webchatJsonRaw,
  '.openclaw/webchat/config.json',
)
