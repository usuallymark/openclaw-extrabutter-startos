import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// Configure Calendar (since 2026.10.1:15). Kept in /data/.openclaw-calendar,
// a folder the gateway user (node) cannot enter: the chown oneshot skips
// it, and the calendar launcher sets it to root:openclaw-calendar 0710 at
// every start. The file itself is root's (0600), so a pasted Google
// sign-in is out of the agents' reach.

export const CAL_ROOT_SUBPATH = '.openclaw-calendar'
export const CAL_SETTINGS_SUBPATH = `${CAL_ROOT_SUBPATH}/settings.json`
// 'invite' (since :28): read, and write by invitations sent by mail (no
// Google sign-in).
export const calendarModes = ['off', 'read', 'write', 'invite'] as const

const shape = z.looseObject({
  mode: z.enum(calendarModes).catch('off'),
  // Shown in the health line and the agent's instructions; the sign-in
  // itself also names the account.
  account: z.string().optional().catch(undefined),
  token: z
    .looseObject({
      // 'none' (since :24): no Google account, calendar links only.
      source: z
        .enum(['from-vaultwarden', 'manual', 'none'])
        .catch('from-vaultwarden'),
      value: z.string().optional().catch(undefined),
    })
    .catch({ source: 'from-vaultwarden' as const, value: undefined }),
  trustedOrganizers: z.array(z.string()).catch([]),
  // Since :16: Configure Email's Trusted Senders count as Trusted
  // Organizers too (the launcher reads both lists at start).
  includeEmailTrusted: z.boolean().catch(true),
  // Write mode (since :16): the name of the assistant's own calendar, and
  // whether every new event (not only those with guests) waits.
  calendarName: z.string().optional().catch(undefined),
  holdAll: z.boolean().catch(false),
  // Since :28: the owner's time zone (IANA) for times without a Google
  // account; blank: the first calendar link's zone, else UTC.
  timeZone: z.string().optional().catch(undefined),
  // Calendar links (since :24): secret iCal addresses read by the calendar
  // service, read only. The address is pasted (url) or fetched at start
  // from Vaultwarden (field "url" of item).
  links: z
    .array(
      z.looseObject({
        name: z.string().catch(''),
        source: z.enum(['manual', 'from-vaultwarden']).catch('manual'),
        url: z.string().optional().catch(undefined),
        item: z.string().optional().catch(undefined),
      }),
    )
    .catch([]),
  agent: z
    .looseObject({
      model: z.string().catch('default'),
      extraInstructions: z.string().optional().catch(undefined),
    })
    .catch({ model: 'default' }),
})

export type CalendarSettings = z.infer<typeof shape>

export const CALENDAR_DEFAULTS: CalendarSettings = {
  mode: 'off',
  token: { source: 'from-vaultwarden' },
  trustedOrganizers: [],
  includeEmailTrusted: true,
  holdAll: false,
  links: [],
  agent: { model: 'default' },
}

export const calendarSettingsJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: CAL_SETTINGS_SUBPATH },
  shape,
)
