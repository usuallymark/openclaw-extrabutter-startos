import { sdk } from '../sdk'
import { openclawJson } from '../fileModels/openclaw.json'
import {
  CalendarSettings,
  calendarSettingsJson,
} from '../fileModels/calendarSettings.json'
import {
  CALENDAR_VAULT,
  parseCalendarSignIn,
  writeCalendarSettings,
} from '../calendarService'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'

const { InputSpec, Value, Variants } = sdk

// Configure Calendar (since 2026.10.1:15): the Google sign-in for the
// calendar service and the calendar agent (read only for now). Stored in
// /data/.openclaw-calendar/settings.json, a root-only file the agents
// cannot read (calendarService.ts).

const EMAIL_RE = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const SIGN_IN_HELP = `A Google sign-in made once on your computer with the script google-signin.py from this package's repository (folder tools/), using a "Desktop app" OAuth client from your own Google Cloud project with the Google Calendar API enabled. It asks only to read calendars. Set the Google Cloud app to "In production" first: in "Testing", Google ends sign-ins after 7 days. The setup guide (Instructions → Calendar) has every step.`

const signIn = Value.union({
  name: 'Google Sign-in',
  description: `${SIGN_IN_HELP}\n\nFetch from Vaultwarden: item "${CALENDAR_VAULT.item}", a hidden custom field "${CALENDAR_VAULT.field}" holding the whole line the script printed. Fetched at every start (requires Vaultwarden in Configure External Services); a new sign-in saved there is picked up within 10 minutes.\nPaste here: stored once, encrypted, on this server only.`,
  default: 'from-vaultwarden',
  variants: Variants.of({
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
  }),
})

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
      'The model that reads the calendars. Invitations can come from strangers and may try to trick the model; a strong cloud model resists that best. A smaller, cheaper model is usually enough for reading schedules (the agent still cannot change anything, run commands or read passwords).',
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
  mode: Value.select({
    name: 'Calendar',
    description:
      "Read only: the calendar agent can list, search and read the events of this Google account, including calendars shared with it. It cannot change anything.\nRead + write on its own calendar: it also adds, changes and cancels events on one calendar of its own (named below), and can invite you and the people on the trusted lists. Anything with guests waits for your approval (Review Agent Actions) before Google emails them. It never changes your calendars or anyone else's, and cannot answer invitations. Needs a sign-in with the extra permission (google-signin.py --scopes calendar.readonly,calendar.app.created).\nOff: no calendar service, no calendar agent.",
    default: 'off',
    values: {
      off: 'Off',
      read: 'Read only',
      write: 'Read + write on its own calendar',
    },
  }),
  account: Value.text({
    name: 'Google Account',
    description:
      'The Google account the sign-in is for (shown in the health line). Filled in from a pasted sign-in when left blank.',
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
  signIn,
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
  includeEmailTrusted: Value.toggle({
    name: "Also Trust Email's Trusted Senders",
    description:
      "The Trusted Senders in Configure Email count as Trusted Organizers too, so you don't type your own and your family's addresses twice. In write mode, the trusted addresses are also the only ones that may be invited.",
    default: true,
  }),
  calendarName: Value.text({
    name: 'Own Calendar Name',
    description:
      "Write mode: the name of the calendar the agent writes to, created in the Google account on the first start (for example your assistant's name). It is also how the agent refers to it. To rename it later, rename the calendar in Google Calendar and change it here too: the agent keeps the calendar it made first, whatever it is called.",
    required: false,
    default: 'Assistant',
    masked: false,
    placeholder: 'Assistant',
  }),
  holdAll: Value.toggle({
    name: 'Hold Every New Event for My Approval',
    description:
      'Write mode: off, events without guests are added (and changed or cancelled) directly, and only those with guests wait for you. On, every change waits for your approval in Review Agent Actions.',
    default: false,
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
      'Connect a Google calendar and set up the calendar agent: the only agent that reads the calendars. It has no shell and no passwords; your main agent asks it what is on. It can also keep a calendar of its own and invite your family, with your approval. Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const s = await calendarSettingsJson
      .read()
      .once()
      .catch(() => null)
    const source = s?.token?.source ?? 'from-vaultwarden'
    return {
      mode: s?.mode ?? 'off',
      account: s?.account || null,
      // The saved sign-in is never shown; blank keeps it.
      signIn:
        source === 'manual'
          ? { selection: 'manual', value: { value: null } }
          : { selection: 'from-vaultwarden', value: {} },
      trustedOrganizers: s?.trustedOrganizers ?? [],
      includeEmailTrusted: s?.includeEmailTrusted ?? true,
      calendarName: s?.calendarName || 'Assistant',
      holdAll: s?.holdAll ?? false,
      agentModel: s?.agent?.model || 'default',
      extraInstructions: s?.agent?.extraInstructions || null,
    } as any
  },

  async ({ effects, input }) => {
    const i = input as any
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
    } else {
      token = { source: 'from-vaultwarden' }
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
      mode: i.mode === 'read' || i.mode === 'write' ? i.mode : 'off',
      account: account || prior?.account || undefined,
      token,
      trustedOrganizers: trusted,
      includeEmailTrusted: i.includeEmailTrusted !== false,
      calendarName:
        String(i.calendarName ?? '').trim() || prior?.calendarName || undefined,
      holdAll: i.holdAll === true,
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
          ? 'Settings saved. OpenClaw is restarting; the calendar service starts on its own, and its state is shown as "Calendar Service" on the service page.' +
            (settings.mode === 'write'
              ? ` Write mode: on the first start the agent's own calendar "${settings.calendarName || 'Assistant'}" is created in the Google account; the sign-in must include calendar.app.created (the Calendar Service line warns if it does not).`
              : '')
          : 'Calendar is off. OpenClaw is restarting.') + scopesNote,
      result: null,
    }
  },
)
