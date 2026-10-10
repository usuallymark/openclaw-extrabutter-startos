import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { sdk } from '../sdk'
import {
  WEBCHAT_ACCENTS,
  type WebchatProfile,
  webchatJson,
} from '../fileModels/webchat.json'

const { InputSpec, Value, Variants } = sdk

const accentNames: Record<(typeof WEBCHAT_ACCENTS)[number], string> = {
  gold: 'Gold',
  teal: 'Teal',
  violet: 'Violet',
  rose: 'Rose',
  blue: 'Blue',
  green: 'Green',
}

const profileSpec = InputSpec.of({
  id: Value.text({
    name: 'Profile ID',
    description:
      'Short lowercase id, e.g. "alex". It becomes the address /u/<id>/ and keeps this person\'s conversations separate. Changing it later hides the conversations made under the old id.',
    required: true,
    default: null,
    placeholder: 'e.g. alex',
    patterns: [
      {
        regex: '^[a-z][a-z0-9-]{0,23}$',
        description:
          'Start with a letter; lowercase letters, digits and hyphens; up to 24 characters.',
      },
    ],
  }),
  name: Value.text({
    name: 'Display name',
    description: 'Shown in the app and on the profile picker.',
    required: true,
    default: null,
    placeholder: 'e.g. Alex',
  }),
  accent: Value.select({
    name: 'Accent color',
    description: null,
    default: 'gold',
    values: accentNames,
  }),
  greeting: Value.textarea({
    name: 'Greeting prompt',
    description:
      'Optional. Sent automatically (hidden) as the first message of each new conversation, so the agent knows who it is talking to. Each conversation\'s topic (its name, e.g. a preset title) is added automatically as "This conversation is about: …". To place the topic yourself, write {topic} — e.g. "Hi, it\'s Alex. This conversation is about {topic}. Please greet me briefly." Even without a greeting, named conversations still tell the agent their topic.',
    required: false,
    default: null,
    minRows: 2,
    maxRows: 4,
  }),
  presets: Value.textarea({
    name: 'Preset conversations',
    description:
      'Optional. One conversation title per line; each appears in the sidebar ready to use. Deleting one in the app hides it.',
    required: false,
    default: null,
    minRows: 3,
    maxRows: 10,
  }),
  pin: Value.text({
    name: 'PIN',
    description:
      'Optional. 4–12 digits, asked once per device. Leave blank to keep the current PIN (or to have no PIN). Setting a new PIN signs out every device for this profile.',
    required: false,
    default: null,
    masked: true,
    placeholder: 'Leave blank to keep',
    inputmode: 'tel',
    patterns: [{ regex: '^\\d{4,12}$', description: '4–12 digits.' }],
  }),
  removePin: Value.toggle({
    name: 'Remove PIN',
    description:
      "Turn on to remove this profile's PIN (anyone on your network can then open it).",
    default: false,
  }),
})

const AVATAR_MAX_BYTES = 1024 * 1024
const webchatDir = sdk.volumes.main.subpath('.openclaw/webchat')

/**
 * Decode a pasted avatar: plain base64 or a data: URI, whitespace allowed.
 * Returns the bytes and file extension, or throws a user-facing error.
 */
export function decodeAvatar(text: string): { bytes: Buffer; ext: string } {
  const b64 = text
    .trim()
    .replace(/^data:[^,]*,/, '')
    .replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
    throw new Error(
      'Avatar image: that is not base64 text. On a Mac run  base64 -i picture.jpg | pbcopy  and paste the result.',
    )
  }
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new Error(
      `Avatar image is ${Math.ceil(bytes.length / 1024)} KB; the limit is 1 MB. Use a smaller image (512×512 is plenty).`,
    )
  }
  const head = bytes.subarray(0, 12)
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    return { bytes, ext: 'png' }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { bytes, ext: 'jpg' }
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { bytes, ext: 'webp' }
  throw new Error('Avatar image must be a PNG, JPEG or WebP picture.')
}

async function removeAvatars() {
  const names = await readdir(webchatDir).catch(() => [] as string[])
  for (const n of names) {
    if (/^avatar\.(png|jpe?g|webp)$/.test(n)) {
      await unlink(`${webchatDir}/${n}`).catch(() => {})
    }
  }
}

const inputSpec = InputSpec.of({
  webchat: Value.union({
    name: 'Webchat',
    description:
      "A mobile-friendly chat app for OpenClaw with one profile per person, each installable on a phone's home screen. Each profile only sees its own conversations. It is reachable by anyone who can reach this server, so add a PIN to any profile that should be private.",
    default: 'disabled',
    variants: Variants.of({
      disabled: { name: 'Disabled', spec: InputSpec.of({}) },
      enabled: {
        name: 'Enabled',
        spec: InputSpec.of({
          appName: Value.text({
            name: 'App name',
            description:
              'Name shown in the app and under the home-screen icon.',
            required: true,
            default: 'OpenClaw',
            placeholder: 'OpenClaw',
          }),
          rememberDays: Value.select({
            name: 'Remember signed-in devices for',
            description: 'Only applies to profiles with a PIN.',
            default: '90',
            values: {
              '30': '30 days',
              '90': '90 days',
              '365': '1 year',
              '0': 'Never expire',
            },
          }),
          avatar: Value.textarea({
            name: 'Avatar image',
            description:
              'Optional. The picture shown in the chat header and used as the home-screen icon, pasted as base64 text (PNG, JPEG or WebP, up to 1 MB). On a Mac: run  base64 -i picture.jpg | pbcopy  in Terminal, then paste here. A square image of 512×512 or larger looks best on home screens.\n\nLeave blank to keep the current avatar.',
            required: false,
            default: null,
            minRows: 2,
            maxRows: 4,
            placeholder: 'Paste base64 here, or leave blank to keep',
          }),
          removeAvatar: Value.toggle({
            name: 'Use the default avatar',
            description: 'Turn on to remove the custom avatar.',
            default: false,
          }),
          profiles: Value.list(
            sdk.List.obj(
              {
                name: 'Profiles',
                description: 'One profile per person using the webchat.',
                default: [],
                minLength: 1,
              },
              {
                spec: profileSpec,
                displayAs: '{{name}} ({{id}})',
                uniqueBy: 'id',
              },
            ),
          ),
        }),
      },
    }),
  }),
})

export function hashPin(pin: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

const lines = (s: string | null | undefined) =>
  (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

export const configureWebchat = sdk.Action.withInput(
  'configure-webchat',

  async () => ({
    name: 'Configure Webchat',
    description:
      'Turn on the mobile-friendly webchat and set up a profile for each person (name, color, optional PIN, preset conversations). Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const cfg = await webchatJson
      .read()
      .once()
      .catch(() => undefined)
    if (!cfg?.enabled) {
      return { webchat: { selection: 'disabled' as const, value: {} } }
    }
    return {
      webchat: {
        selection: 'enabled' as const,
        value: {
          appName: cfg.appName || 'OpenClaw',
          avatar: null, // never echoed
          removeAvatar: false,
          rememberDays: (['30', '90', '365', '0'].includes(
            String(cfg.rememberDays),
          )
            ? String(cfg.rememberDays)
            : '90') as '30' | '90' | '365' | '0',
          profiles: cfg.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            accent: p.accent,
            greeting: p.greeting || null,
            presets: p.presets.join('\n') || null,
            pin: null, // never echoed
            removePin: false,
          })),
        },
      },
    }
  },

  async ({ effects, input }) => {
    const i = input as any
    const prev = await webchatJson
      .read()
      .once()
      .catch(() => undefined)
    const prevById = new Map<string, WebchatProfile>(
      (prev?.profiles ?? []).map((p) => [p.id, p]),
    )

    if (i.webchat.selection !== 'enabled') {
      // Keep profiles (and PIN hashes) so re-enabling restores them.
      await webchatJson.write(effects, {
        enabled: false,
        appName: prev?.appName ?? 'OpenClaw',
        rememberDays: prev?.rememberDays ?? 90,
        profiles: prev?.profiles ?? [],
      })
    } else {
      const v = i.webchat.value
      // Validate the avatar before writing anything, so a bad paste changes nothing.
      const avatar =
        !v.removeAvatar && v.avatar && String(v.avatar).trim()
          ? decodeAvatar(String(v.avatar))
          : null
      const profiles: WebchatProfile[] = (v.profiles ?? []).map((p: any) => {
        const old = prevById.get(p.id)
        let pinHash = old?.pinHash ?? null
        let pinVersion = old?.pinVersion ?? 0
        if (p.removePin) {
          if (pinHash) pinVersion += 1
          pinHash = null
        } else if (p.pin) {
          pinHash = hashPin(String(p.pin))
          pinVersion += 1
        }
        return {
          id: p.id,
          name: String(p.name).trim() || p.id,
          accent: WEBCHAT_ACCENTS.includes(p.accent) ? p.accent : 'gold',
          greeting: (p.greeting ?? '').trim(),
          presets: lines(p.presets),
          pinHash,
          pinVersion,
        }
      })
      if (v.removeAvatar) {
        await removeAvatars()
      } else if (avatar) {
        await mkdir(webchatDir, { recursive: true })
        await removeAvatars()
        await writeFile(`${webchatDir}/avatar.${avatar.ext}`, avatar.bytes, {
          mode: 0o644,
        })
      }
      await webchatJson.write(effects, {
        enabled: true,
        appName: String(v.appName ?? '').trim() || 'OpenClaw',
        rememberDays: Number(v.rememberDays) || 0,
        profiles,
      })
    }

    await effects.restart()
    return {
      version: '1' as const,
      title: 'Webchat Configured',
      message:
        i.webchat.selection === 'enabled'
          ? 'Saved. OpenClaw is restarting; the Webchat address appears under Interfaces.'
          : 'Webchat disabled. OpenClaw is restarting.',
      result: null,
    }
  },
)
