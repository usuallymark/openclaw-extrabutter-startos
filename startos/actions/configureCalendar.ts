import { sdk } from '../sdk'
import { openclawJson } from '../fileModels/openclaw.json'
import { emailSettingsJson } from '../fileModels/emailSettings.json'
import {
  CalendarSettings,
  calendarSettingsJson,
} from '../fileModels/calendarSettings.json'
import {
  CALENDAR_VAULT,
  parseCalendarSignIn,
  trustedOrganizersOf,
  writeCalendarSettings,
} from '../calendarService'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import {
  credentialUnion,
  credToPrefill,
  credToStored,
} from './configureExternalServices'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'
import { GROUP_APPS } from './groups'

const { InputSpec, Value, Variants } = sdk

// Configure Calendar (since 2026.10.1:15): the Google sign-in for the
// calendar service and the calendar agent, and (since :24) calendar links:
// secret iCal addresses read without any Google sign-in. Stored in
// /data/.openclaw-calendar/settings.json, a root-only file the agents
// cannot read (calendarService.ts).

const EMAIL_RE = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const SIGN_IN_HELP = `A Google sign-in made once on your computer with the script google-signin.py from this package's repository (folder tools/), using a "Desktop app" OAuth client from your own Google Cloud project with the Google Calendar API enabled. It asks only to read calendars. Set the Google Cloud app to "In production" first: in "Testing", Google ends sign-ins after 7 days. The setup guide (Instructions → Calendar) has every step.`

const LINK_RE = '^(https?|webcals?)://\\S+$'

// The saved settings, for defaults of fields in a Calendar choice that is
// not the saved one (StartOS shows a choice's defaults when you switch to
// it; these keep what you entered for that mode before).
const saved = () =>
  calendarSettingsJson
    .read()
    .once()
    .catch(() => null)

const SIGN_IN_VARIANTS = {
  'from-vaultwarden': {
    name: 'Fetch from Vaultwarden',
    spec: InputSpec.of({}),
  },
  manual: {
    name: 'Paste here',
    spec: InputSpec.of({
      value: Value.textarea({
        name: 'Sign-in (JSON)',
        description:
          'The whole line printed by google-signin.py. Leave blank to keep the sign-in already saved.',
        required: false,
        default: null,
        minRows: 3,
        maxRows: 8,
        placeholder:
          'Leave blank to keep the saved sign-in. {"type":"openclaw-google-signin","account":"…","refresh_token":"…",…}',
      }),
    }),
  },
}

// A CalDAV account (since :37): iCloud, Fastmail, Nextcloud and other
// CalDAV servers, instead of Google. The calendar service finds the server
// and the calendars itself at start (gcalendar/caldav.py).
const caldavFields = (withZone: boolean) =>
  InputSpec.of({
    server: Value.dynamicText(async () => ({
      name: 'Server (optional)',
      description:
        "The CalDAV address from your provider's help pages (https://…), e.g. https://cloud.example.com/remote.php/dav for Nextcloud. Blank: found from the Account address below (iCloud, Fastmail and Yahoo by name, otherwise the domain's /.well-known/caldav). Look Up Calendar Server shows what is found.",
      required: false,
      default: (await saved())?.caldav?.server || null,
      masked: false,
      placeholder: 'Blank: from the Account address',
      patterns: [
        {
          regex: '^https://\\S+$',
          description:
            'An https:// address (the password would otherwise travel in clear)',
        },
      ],
    })),
    username: Value.dynamicText(async () => ({
      name: 'User Name (optional)',
      description:
        'Blank: the Account address (right for iCloud, Fastmail and Yahoo). Nextcloud and other servers: your user name there.',
      required: false,
      default: (await saved())?.caldav?.username || null,
      masked: false,
      placeholder: 'Same as the Account address',
    })),
    password: credentialUnion(
      'App Password',
      'caldav',
      'password',
      'An app-specific password made for this (iCloud: account.apple.com → Sign-In and Security → App-Specific Passwords; Fastmail: Settings → Privacy & Security → Manage app passwords and access → New app password, access Mail, Contacts & Calendars; Nextcloud: Settings → Security → create an app password). Only the calendar service can fetch it; a password the server refused is not tried again until a new one is saved.',
    ),
    ...(withZone ? { timeZone } : {}),
  })

const SIGN_IN_DESCRIPTION = `${SIGN_IN_HELP}\n\nFetch from Vaultwarden: item "${CALENDAR_VAULT.item}", a hidden custom field "${CALENDAR_VAULT.field}" holding the whole line the script printed. Fetched at every start (requires Vaultwarden in Configure External Services); a new sign-in saved there is picked up within 10 minutes.\nPaste here: stored once, encrypted, on this server only.`

const CALDAV_DESCRIPTION =
  'CalDAV account: a calendar account at iCloud, Fastmail, Nextcloud or another CalDAV server, with an app password (Instructions → Calendar).'

/** The calendar account for Read only: Google, CalDAV, or none (calendar
 * links only). */
const readSignIn = Value.dynamicUnion(async () => {
  const src = (await saved())?.token?.source ?? 'none'
  return {
    name: 'Calendar Account',
    description: `No account: read only the Calendar Links (simplest; nothing to set up).\n${CALDAV_DESCRIPTION}\nGoogle: ${SIGN_IN_DESCRIPTION}`,
    default: src,
    disabled: false,
    variants: Variants.of({
      none: {
        name: 'No account (calendar links only)',
        spec: InputSpec.of({}),
      },
      caldav: {
        name: 'CalDAV account (iCloud, Fastmail, Nextcloud…)',
        spec: caldavFields(false),
      },
      'from-vaultwarden': {
        ...SIGN_IN_VARIANTS['from-vaultwarden'],
        name: 'Google: fetch the sign-in from Vaultwarden',
      },
      manual: { ...SIGN_IN_VARIANTS.manual, name: 'Google: paste the sign-in' },
    }),
  }
})

/** The calendar account for Read + write on its own calendar: Google or
 * CalDAV. */
const writeSignIn = Value.dynamicUnion(async () => {
  const src = (await saved())?.token?.source
  return {
    name: 'Calendar Account',
    description: `${CALDAV_DESCRIPTION} The own calendar is made on that account (when the server does not let apps make calendars, make one with the Own Calendar Name yourself).\nGoogle: ${SIGN_IN_DESCRIPTION}\nWriting on Google needs a sign-in with the extra permission (google-signin.py --scopes calendar.readonly,calendar.app.created).`,
    default:
      src === 'manual'
        ? 'manual'
        : src === 'caldav'
          ? 'caldav'
          : 'from-vaultwarden',
    disabled: false,
    variants: Variants.of({
      caldav: {
        name: 'CalDAV account (iCloud, Fastmail, Nextcloud…)',
        spec: caldavFields(true),
      },
      'from-vaultwarden': {
        ...SIGN_IN_VARIANTS['from-vaultwarden'],
        name: 'Google: fetch the sign-in from Vaultwarden',
      },
      manual: { ...SIGN_IN_VARIANTS.manual, name: 'Google: paste the sign-in' },
    }),
  }
})

const calendarName = Value.dynamicText(async () => ({
  name: 'Own Calendar Name',
  description:
    "The name of the calendar the agent writes to, created in the Google or CalDAV account on the first start (for example your assistant's name). It is also how the agent refers to it. To rename it later, rename the calendar in your calendar app and change it here too: the agent keeps the calendar it made first, whatever it is called.",
  required: false,
  default: (await saved())?.calendarName || 'Assistant',
  masked: false,
  placeholder: 'Assistant',
}))

const holdAll = (what: string) =>
  Value.dynamicToggle(async () => ({
    name: 'Hold Every New Event for My Approval',
    description: what,
    default: (await saved())?.holdAll ?? false,
  }))

const timeZone = Value.dynamicText(async () => ({
  name: 'Time Zone',
  description:
    "Your time zone, for the times the agent reads and sends (an IANA name, e.g. America/Chicago or Europe/Berlin). Blank: the first calendar link's zone, else UTC. (With a Google account its calendar's zone is used.)",
  required: false,
  default: (await saved())?.timeZone || null,
  masked: false,
  placeholder: 'America/Chicago',
}))

/** Whether Configure Email can send invitations: Gmail or IMAP, sending by
 * rules. The reason when not. */
async function emailReadyForInvites(): Promise<string> {
  const email = await emailSettingsJson
    .read()
    .once()
    .catch(() => null)
  const m = email?.account?.mode
  if (m !== 'gmail' && m !== 'imap')
    return 'Configure Email is not set to Gmail or IMAP'
  if ((email?.sending?.level ?? 'drafts') !== 'rules')
    return 'Configure Email → Sending is not "Send by rules"'
  return ''
}

/** The trusted list as saved, for the form (since :44). */
export function trustedFootnote(
  s: CalendarSettings | null | undefined,
  emailTrusted: string[],
): string {
  const own = (s?.trustedOrganizers ?? []).length
  const fromEmail = s?.includeEmailTrusted !== false ? emailTrusted.length : 0
  const all = s
    ? trustedOrganizersOf(s, emailTrusted)
    : Array.from(
        new Set(emailTrusted.map((t) => String(t).trim().toLowerCase())),
      )
        .filter(Boolean)
        .sort()
  if (!all.length)
    return 'Trusted now: nobody. Every organizer is marked as outside.'
  const shown = all.length > 20 ? [...all.slice(0, 20), '…'] : all
  return (
    `Trusted now, as saved (${all.length}: ${own} from Trusted Organizers, ${fromEmail} from Configure Email's Trusted Senders, duplicates counted once): ` +
    shown.join(', ') +
    '. Changes here show after saving.'
  )
}

const calendarMode = Value.dynamicUnion(async () => {
  const s = await saved()
  const notReady = await emailReadyForInvites()
  return {
    name: 'Calendar',
    description:
      'Read only: the calendar agent reads the Calendar Links and the calendars of the Google or CalDAV account; it changes nothing.\nRead + write: it also keeps one calendar of its own in that account and can invite the people on your trusted lists; anything with guests waits for your approval.\nRead + invitations by mail: no calendar account; it sends invitations by email under your Configure Email rules (needs a Calendar Link, and Configure Email set to Send by rules).' +
      (notReady && s?.mode !== 'invite'
        ? `\n\nInvitations by mail cannot be chosen yet: ${notReady}.`
        : ''),
    default: s?.mode ?? 'off',
    disabled: notReady && s?.mode !== 'invite' ? ['invite'] : false,
    variants: Variants.of({
      off: { name: 'Off', spec: InputSpec.of({}) },
      read: {
        name: 'Read only',
        spec: InputSpec.of({ signIn: readSignIn, timeZone }),
      },
      write: {
        name: 'Read + write on its own calendar',
        spec: InputSpec.of({
          signIn: writeSignIn,
          calendarName,
          holdAll: holdAll(
            'Off: events without guests are added (and changed or cancelled) directly, and only those with guests wait for you. On: every change waits for your approval in Review Agent Actions.',
          ),
        }),
      },
      invite: {
        name: 'Read + invitations by mail (no calendar account)',
        spec: InputSpec.of({
          timeZone,
          holdAll: holdAll(
            'Off: invitations follow your Configure Email rules (sent straight away to Send Automatically To, anyone else waits for you). On: every invitation waits for your approval in Review Agent Actions.',
          ),
        }),
      },
    }),
  }
})

const links = Value.list(
  sdk.List.obj(
    {
      name: 'Calendar Links',
      description:
        'Calendars read through their secret iCal address, read only, with no sign-in. At least one is needed without a calendar account. Where to copy it: Google Calendar → Settings → (the calendar) → Integrate calendar → "Secret address in iCal format"; iCloud → share as a Public Calendar; Outlook → Settings → Calendar → Shared calendars → Publish a calendar → ICS link. Anyone with the address sees the calendar: it stays on this server, never reaches the agents, and can be reset where you copied it.',
      default: [],
    },
    {
      spec: InputSpec.of({
        name: Value.text({
          name: 'Name',
          description:
            'How the agent calls this calendar, e.g. "Family" or "Sam\'s school".',
          required: true,
          default: null,
          masked: false,
          placeholder: 'Family',
        }),
        url: Value.text({
          name: 'Secret Address',
          description:
            'The whole address, starting with https:// or webcal://. Leave blank to keep the address already saved for this name, or to use Vaultwarden below.',
          required: false,
          default: null,
          masked: true,
          placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
          patterns: [
            {
              regex: LINK_RE,
              description:
                'A web address starting with https://, http:// or webcal://',
            },
          ],
        }),
        item: Value.text({
          name: 'Or Fetch from Vaultwarden Item',
          description:
            'Instead of pasting: the name of a Vaultwarden item with a custom field "url" holding the address (fetched at every start; requires Vaultwarden in Configure External Services). Used when Secret Address is blank.',
          required: false,
          default: null,
          masked: false,
          placeholder: 'calendar-family',
        }),
      }),
      displayAs: '{{name}}',
      uniqueBy: 'name',
    },
  ),
)

const agentModel = Value.dynamicSelect(async () => {
  const cfg = ((await openclawJson
    .read()
    .once()
    .catch(() => undefined)) ?? {}) as any
  const main = cfg?.agents?.defaults?.model?.primary
  const current = (await calendarSettingsJson
    .read((s) => s.agent?.model)
    .once()
    .catch(() => undefined)) as string | undefined
  return {
    name: 'Calendar Agent Model',
    description:
      'The model that reads the calendars. Invitations can come from strangers and may try to trick the model; a strong cloud model resists that best. A smaller, cheaper model is usually enough for reading schedules (the agent still cannot touch your own calendars, run commands or read passwords).',
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

const inputSpec = InputSpec.of({
  mode: calendarMode,
  account: Value.text({
    name: 'Account',
    description:
      'With Google: the Google account the sign-in is for (shown in the health line; filled in from a pasted sign-in when left blank). With a CalDAV account: its address (finds the server when Server is blank, and is the organizer of invitations). Otherwise: optional, your address as the calendar links know you, so your own events and answers are recognised.',
    required: false,
    default: null,
    masked: false,
    placeholder: 'assistant@gmail.com',
    inputmode: 'email',
    patterns: [
      {
        regex: EMAIL_RE,
        description: 'An email address, e.g. you@gmail.com',
      },
    ],
  }),
  links,
  trustedOrganizers: Value.list(
    sdk.List.text(
      {
        name: 'Trusted Organizers',
        description:
          "Addresses whose events are marked as from a trusted organizer, typically your own and your family's. Everyone else is marked as an outside organizer. Google accounts cannot pretend to be another Google account inside Google Calendar, but an emailed invitation can claim any organizer; those are marked separately whatever this list says.",
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
  ),
  includeEmailTrusted: Value.dynamicToggle(async () => {
    // Since :44: the footnote shows the combined list as saved, the one the
    // calendar service uses (Trusted Organizers plus, while this is on,
    // Configure Email's Trusted Senders).
    const s = await saved()
    const senders =
      (await emailSettingsJson
        .read((e) => e?.agent?.trustedSenders)
        .once()
        .catch(() => null)) ?? []
    return {
      name: "Also Trust Email's Trusted Senders",
      description:
        "The Trusted Senders in Configure Email count as Trusted Organizers too, so you don't type your own and your family's addresses twice. In write mode, the trusted addresses are also the only ones that may be invited.",
      footnote: trustedFootnote(s, senders),
      default: s?.includeEmailTrusted ?? true,
    }
  }),
  agentModel,
  extraInstructions: Value.textarea({
    name: 'Extra Instructions (optional)',
    description:
      'Added to the calendar agent\'s instructions, e.g. "The Sam calendar is our son\'s". They cannot loosen its rules.',
    required: false,
    default: null,
    minRows: 2,
    maxRows: 8,
    placeholder: "The Sam calendar is our son's.",
  }),
})

export const configureCalendar = sdk.Action.withInput(
  'configure-calendar',

  async () => ({
    name: 'Configure Calendar',
    description:
      'Connect calendars (calendar links, a CalDAV account such as iCloud or Fastmail, or a Google account) and set up the calendar agent: the only agent that reads the calendars. It has no shell and no passwords; your main agent asks it what is on. It can also keep a calendar of its own and invite your family, with your approval. Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_APPS,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const s = await calendarSettingsJson
      .read()
      .once()
      .catch(() => null)
    const source = s?.token?.source ?? 'from-vaultwarden'
    const mode = s?.mode ?? 'off'
    const zone = s?.timeZone || null
    // The saved sign-in is never shown; blank keeps it.
    const caldav = (withZone: boolean) => ({
      selection: 'caldav',
      value: {
        server: s?.caldav?.server || null,
        username: s?.caldav?.username || null,
        password: credToPrefill(s?.caldav?.password),
        ...(withZone ? { timeZone: zone } : {}),
      },
    })
    const signIn =
      source === 'manual'
        ? { selection: 'manual', value: { value: null } }
        : source === 'caldav'
          ? caldav(mode === 'write')
          : source === 'none' && mode !== 'write'
            ? { selection: 'none', value: {} }
            : { selection: 'from-vaultwarden', value: {} }
    const hold = s?.holdAll ?? false
    return {
      mode:
        mode === 'read'
          ? { selection: 'read', value: { signIn, timeZone: zone } }
          : mode === 'write'
            ? {
                selection: 'write',
                value: {
                  signIn,
                  calendarName: s?.calendarName || 'Assistant',
                  holdAll: hold,
                },
              }
            : mode === 'invite'
              ? {
                  selection: 'invite',
                  value: { timeZone: zone, holdAll: hold },
                }
              : { selection: 'off', value: {} },
      account: s?.account || null,
      // Saved addresses are never shown; blank keeps them.
      links: (s?.links ?? []).map((l) => ({
        name: l.name,
        url: null,
        item: l.source === 'from-vaultwarden' ? l.item || null : null,
      })),
      trustedOrganizers: s?.trustedOrganizers ?? [],
      includeEmailTrusted: s?.includeEmailTrusted ?? true,
      agentModel: s?.agent?.model || 'default',
      extraInstructions: s?.agent?.extraInstructions || null,
    } as any
  },

  async ({ effects, input }) => {
    // The Calendar choice carries its own fields; the rest are shared.
    const raw = input as any
    const sel = raw.mode?.selection ?? 'off'
    const v = raw.mode?.value ?? {}
    const i = {
      ...raw,
      mode: sel,
      signIn:
        sel === 'read' || sel === 'write'
          ? v.signIn
          : { selection: sel === 'invite' ? 'none' : undefined },
      // With a CalDAV account in write mode, the zone is in its fields.
      timeZone:
        v.timeZone ??
        (v.signIn?.selection === 'caldav'
          ? v.signIn?.value?.timeZone
          : undefined),
      holdAll: v.holdAll,
      calendarName: v.calendarName,
    }
    const prior = await calendarSettingsJson
      .read()
      .once()
      .catch(() => null)
    let account = String(i.account ?? '')
      .trim()
      .toLowerCase()
    let token: CalendarSettings['token']
    let scopesNote = ''
    if (i.signIn?.selection === 'manual') {
      const pasted = String(i.signIn?.value?.value ?? '').trim()
      if (pasted) {
        const parsed = parseCalendarSignIn(pasted)
        if (!account && parsed.account) account = parsed.account.toLowerCase()
        if (
          parsed.scopes.length &&
          !parsed.scopes.some((s) =>
            [
              'calendar.readonly',
              'calendar',
              'calendar.events.readonly',
            ].includes(s),
          )
        ) {
          throw new Error(
            `This sign-in does not allow reading calendars (it allows: ${parsed.scopes.join(', ')}). Run google-signin.py again and tick the Calendar box on Google's page.`,
          )
        }
        if (
          i.mode === 'write' &&
          parsed.scopes.length &&
          !parsed.scopes.includes('calendar.app.created')
        ) {
          throw new Error(
            'Write mode needs a sign-in with the extra permission. Run google-signin.py again with --scopes calendar.readonly,calendar.app.created, or choose Read only.',
          )
        }
        if (
          parsed.scopes.some((s) => s === 'calendar' || s === 'calendar.events')
        )
          scopesNote =
            ' Note: this sign-in also allows changes to calendars. The calendar service never makes any, but a read-only sign-in is safer.'
        token = { source: 'manual', value: pasted }
      } else if (prior?.token?.source === 'manual' && prior.token.value) {
        token = prior.token
      } else if (i.mode !== 'off') {
        throw new Error(
          'Paste the sign-in (the line printed by google-signin.py), or choose Fetch from Vaultwarden.',
        )
      } else {
        token = { source: 'manual' }
      }
    } else if (i.signIn?.selection === 'none') {
      token = { source: 'none' }
    } else if (i.signIn?.selection === 'caldav') {
      token = { source: 'caldav' }
    } else if (sel === 'off') {
      // Off: keep whatever sign-in choice was saved, for switching back.
      token = prior?.token ?? { source: 'from-vaultwarden' }
    } else {
      token = { source: 'from-vaultwarden' }
    }
    // The CalDAV account (since :37).
    let caldav = prior?.caldav
    if (token.source === 'caldav' && sel !== 'off') {
      const c = i.signIn?.value ?? {}
      const server = String(c.server ?? '').trim()
      if (server && !/^https:\/\/\S+$/i.test(server))
        throw new Error(
          'Server: an https:// address (the password would otherwise travel in clear).',
        )
      if (!server && !account)
        throw new Error(
          'CalDAV account: give the Server address, or your address at the provider under Account (the server is found from it).',
        )
      if (
        !server &&
        /@(gmail|googlemail)\.com$|@(outlook|hotmail|live|msn)\./i.test(account)
      )
        throw new Error(
          /@(gmail|googlemail)/i.test(account)
            ? 'Google calendars use the Google sign-in (choose a Google option under Calendar Account), not CalDAV.'
            : 'Outlook.com and Microsoft 365 do not offer CalDAV; add your Outlook calendar as a Calendar Link instead.',
        )
      let password = credToStored(c.password)
      if (password?.source === 'manual' && !password.value) {
        if (
          prior?.caldav?.password?.source === 'manual' &&
          prior.caldav.password.value
        )
          password = prior.caldav.password as any
        else
          throw new Error(
            'App Password: enter the app password, or choose Fetch from Vaultwarden (item "caldav").',
          )
      }
      caldav = {
        server: server || undefined,
        username: String(c.username ?? '').trim() || undefined,
        password: password as any,
      }
    }
    const savedLinks = new Map(
      (prior?.links ?? []).map((l) => [l.name.trim().toLowerCase(), l]),
    )
    const linkList: NonNullable<CalendarSettings['links']> = []
    for (const l of (i.links ?? []) as any[]) {
      const name = String(l?.name ?? '').trim()
      if (!name) continue
      const url = String(l?.url ?? '').trim()
      const item = String(l?.item ?? '').trim()
      const saved = savedLinks.get(name.toLowerCase())
      if (url) {
        if (!new RegExp(LINK_RE, 'i').test(url))
          throw new Error(
            `Calendar link "${name}": the address must start with https://, http:// or webcal://.`,
          )
        linkList.push({ name, source: 'manual', url })
      } else if (item) {
        if (item.includes(':'))
          throw new Error(
            `Calendar link "${name}": a Vaultwarden item name cannot contain ":".`,
          )
        linkList.push({ name, source: 'from-vaultwarden', item })
      } else if (saved?.source === 'manual' && saved.url) {
        linkList.push({ name, source: 'manual', url: saved.url })
      } else {
        throw new Error(
          `Calendar link "${name}": paste its secret address, or name the Vaultwarden item that holds it.`,
        )
      }
    }
    if (i.mode !== 'off' && token.source === 'none' && !linkList.length) {
      throw new Error(
        i.mode === 'invite'
          ? 'Read + invitations by mail needs at least one Calendar Link (to read your calendar); add one under Calendar Links.'
          : 'Without a Google account, add at least one Calendar Link (or choose a Google sign-in).',
      )
    }
    const zone = String(i.timeZone ?? '').trim()
    if (
      zone &&
      !Intl.supportedValuesOf('timeZone').includes(zone) &&
      zone !== 'UTC'
    )
      throw new Error(
        `Time Zone: "${zone}" is not a time zone name (for example America/Chicago).`,
      )
    if (i.mode === 'write' && token.source === 'none')
      throw new Error(
        'Read + write on its own calendar needs the Google sign-in.',
      )
    if (i.mode === 'invite') {
      // The choice is disabled while this is so; this catches a change in
      // Configure Email made while the form was open.
      const notReady = await emailReadyForInvites()
      if (notReady)
        throw new Error(
          `Read + invitations by mail sends the invitations through the mail service, but ${notReady}. Change that in Configure Email first.`,
        )
    }
    const trusted = Array.from(
      new Set(
        ((i.trustedOrganizers ?? []) as string[])
          .map((t) => String(t).trim().toLowerCase())
          .filter(Boolean),
      ),
    )
    const settings: CalendarSettings = {
      ...(prior ?? {}),
      mode:
        i.mode === 'read' || i.mode === 'write' || i.mode === 'invite'
          ? i.mode
          : 'off',
      // Fields of the other choices keep their saved values, for switching
      // back.
      timeZone:
        sel === 'read' || sel === 'invite' || token.source === 'caldav'
          ? zone || undefined
          : prior?.timeZone,
      caldav,
      account: account || prior?.account || undefined,
      token,
      trustedOrganizers: trusted,
      includeEmailTrusted: i.includeEmailTrusted !== false,
      calendarName:
        String(i.calendarName ?? '').trim() || prior?.calendarName || undefined,
      holdAll:
        sel === 'write' || sel === 'invite'
          ? i.holdAll === true
          : (prior?.holdAll ?? false),
      links: linkList,
      agent: {
        ...(prior?.agent ?? {}),
        model: String(i.agentModel || 'default'),
        extraInstructions:
          String(i.extraInstructions ?? '').trim() || undefined,
      },
    } as CalendarSettings
    await writeCalendarSettings(effects, settings)
    await effects.restart()
    return {
      version: '1' as const,
      title: 'Calendar Configured',
      message:
        (settings.mode !== 'off'
          ? 'Settings saved. OpenClaw is restarting; the calendar service starts on its own, and its state is shown as "Calendar Service" on the service page' +
            (linkList.length
              ? `, including whether each of the ${linkList.length} calendar link${linkList.length > 1 ? 's' : ''} can be read.`
              : '.') +
            (settings.mode === 'invite'
              ? ' Invitations by mail: they go out under your Configure Email rules, so mail to anyone not on Send Automatically To waits in Review Agent Actions.'
              : '') +
            (settings.mode === 'write' && token.source !== 'caldav'
              ? ` Write mode: on the first start the agent's own calendar "${settings.calendarName || 'Assistant'}" is created in the Google account; the sign-in must include calendar.app.created (the Calendar Service line warns if it does not).`
              : '') +
            (token.source === 'caldav'
              ? ` CalDAV: the service finds the server and the calendars itself; the Calendar Service line says what it found${settings.mode === 'write' ? `, and whether the own calendar "${settings.calendarName || 'Assistant'}" could be made` : ''}.`
              : '')
          : 'Calendar is off. OpenClaw is restarting.') + scopesNote,
      result: null,
    }
  },
)
