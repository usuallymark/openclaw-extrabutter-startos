import { sdk } from '../sdk'
import { inOpenclawContainer } from '../gatewayContainer'
import { GROUP_APPS } from './groups'

const { InputSpec, Value } = sdk

// Look Up Calendar Server (since :37): what the calendar service would find
// for a CalDAV account, run by the calendar service's own code
// (gcalendar/caldav.py) as its user, with the same network rules. Saves
// nothing; a password typed here is used for this lookup only.
export const lookUpCalendarServer = sdk.Action.withInput(
  'look-up-calendar-server',

  async () => ({
    name: 'Look Up Calendar Server',
    description:
      'Shows the CalDAV server Configure Calendar would find for a calendar account (iCloud, Fastmail, Nextcloud…) and, with the app password, its calendars. Saves nothing.',
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_APPS,
    visibility: 'enabled',
  }),

  InputSpec.of({
    target: Value.text({
      name: 'Server or Email Address',
      description:
        "The server address (https://…), or your address at the provider (the server is found from it: iCloud, Fastmail and Yahoo by name, otherwise the domain's /.well-known/caldav).",
      required: true,
      default: null,
      masked: false,
      placeholder: 'you@icloud.com',
    }),
    username: Value.text({
      name: 'User Name (optional)',
      description: 'Blank: the email address.',
      required: false,
      default: null,
      masked: false,
      placeholder: 'Same as the email address',
    }),
    password: Value.text({
      name: 'App Password (optional)',
      description:
        'To list the calendars too. Used for this lookup only, never saved. Blank: only the server is looked up.',
      required: false,
      default: null,
      masked: true,
      placeholder: 'Blank: server only',
    }),
  }),

  async () => ({}),

  async ({ effects, input }) => {
    const target = String(input.target ?? '').trim()
    const req = {
      target,
      username: String(input.username ?? '').trim(),
      password: String(input.password ?? ''),
    }
    const res = await inOpenclawContainer(effects, 'calendar-lookup', (sub) =>
      sub.exec(
        ['python3', '-I', '/opt/openclaw-calendar/caldav.py', 'lookup'],
        {
          user: 'openclaw-calendar',
          input: JSON.stringify(req),
          timeout: 150_000,
        },
      ),
    )
    let out: any = null
    try {
      out = JSON.parse(String(res.stdout))
    } catch {
      out = null
    }
    if (!out)
      throw new Error(
        `The lookup did not finish: ${String(res.stderr).trim().split('\n').pop() || `exit ${res.exitCode}`}`,
      )
    const lines: string[] = []
    if (out.server) {
      lines.push(`Server: ${out.server}`)
      lines.push(`Address: ${out.url}`)
      lines.push(`Found from: ${out.found}`)
    }
    if (Array.isArray(out.calendars)) {
      if (out.address) lines.push(`Account address: ${out.address}`)
      lines.push(
        `Sends invitations to guests itself: ${out.scheduling ? 'yes' : 'no (the agent can add events, but without guests)'}`,
      )
      lines.push(
        `Calendars (${out.calendars.length}): ${
          out.calendars
            .map((c: any) => `${c.name}${c.writable ? '' : ' (read only)'}`)
            .join(', ') || 'none'
        }`,
      )
    }
    if (out.note) lines.push(`Note: ${out.note}`)
    if (out.error) lines.push(`Problem: ${out.error}`)
    return {
      version: '1' as const,
      title: 'Calendar Server',
      message: out.error
        ? `Not usable as it is. Nothing was saved.`
        : `Found for ${target}. Nothing was saved.`,
      result: {
        type: 'single' as const,
        value: lines.join('\n'),
        copyable: true,
        qr: false,
        masked: false,
      },
    }
  },
)
