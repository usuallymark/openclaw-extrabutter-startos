import { sdk } from '../sdk'
import { agentctl } from '../agentActions'
import { GROUP_DAILY } from './groups'

// Agent Activity (since 2026.10.1:18; Email Activity before): the isolated
// services' logs, newest first. Since :44 a small form (service, period,
// changes only), a one-line summary, and one collapsible section per service
// (StartOS draws a group nested in the result group as an accordion): what the email and calendar agents read,
// filed, drafted, sent, added, changed and cancelled, what the rules refused
// or held, and the owner's decisions. Neither log holds message text or
// event descriptions.

type Entry = Record<string, unknown> & { ts?: string; event?: string }

type Service = {
  id: 'mail' | 'calendar' | 'contacts' | 'vault'
  label: string
  /** The section title for this service's changes or refusals. */
  title: string
  /** Events that changed something or waited for the owner. */
  isChange: (ev: string) => boolean
  labels: Record<string, string>
}

const SERVICES: Service[] = [
  {
    id: 'mail',
    label: 'Email',
    title: 'Email sending',
    isChange: (ev) => ev.startsWith('send_'),
    labels: {
      state: 'Mail service',
      list: 'Listed',
      search: 'Searched',
      read: 'Read',
      attachments: 'Listed attachments',
      attachment_text: 'Read attachment text',
      released: 'Copied attachments to the workspace',
      mark_read: 'Marked read',
      flag: 'Flagged',
      move: 'Moved',
      archive: 'Archived',
      draft: 'Draft saved',
      send_sent: 'SENT',
      send_queued: 'Held for approval',
      send_refused: 'Send refused',
      send_rejected: 'Rejected by you',
      send_expired: 'Expired (not decided in 5 days)',
      send_cancelled: 'Cancelled (draft changed or gone)',
      send_failed: 'Sending failed',
      send_retry: 'Sending failed, will retry',
      auth_refused: 'Password refused by the mailbox',
      replies_filed: 'Invitation replies moved to Calendar Replies',
      invite_refused: 'Invitation request refused',
      error: 'Tool error',
    },
  },
  {
    id: 'calendar',
    label: 'Calendar',
    title: 'Calendar changes',
    isChange: (ev) =>
      ev.startsWith('write_') ||
      ev.startsWith('own_calendar') ||
      ev.startsWith('invite_'),
    labels: {
      state: 'Calendar service',
      sign_in_refused: 'Sign-in refused by Google',
      calendars: 'Listed calendars',
      list: 'Listed events',
      search: 'Searched',
      read: 'Read event',
      own_calendar_created: 'Own calendar created',
      own_calendar_gone: 'Own calendar missing',
      own_calendar_zone: 'Own calendar time zone set',
      write_done: 'DONE',
      invite_sent: 'INVITATION SENT',
      invite_queued: 'Invitation held for approval (mail)',
      invite_refused: 'Invitation refused',
      invite_failed: 'Invitation failed',
      write_queued: 'Held for approval',
      write_rejected: 'Rejected by you',
      write_expired: 'Expired (not decided in time)',
      write_refused: 'Refused',
      write_failed: 'Failed',
      queue_error: 'Approval queue error',
      error: 'Tool error',
    },
  },
  {
    // Since :31: counts only (never a name, address or number).
    id: 'contacts',
    label: 'Contacts',
    title: 'Contacts service',
    isChange: (ev) => ev === 'state' || ev === 'loaded',
    labels: {
      state: 'Contacts service',
      loaded: 'Address book read',
      search: 'Searched',
      lookup: 'Looked up',
      read: 'Read a contact',
      birthdays: 'Listed birthdays',
      error: 'Tool error',
    },
  },
  {
    // Since :27: which Vaultwarden items were asked for, by the package or
    // an agent, and which were refused (names only, never values).
    id: 'vault',
    label: 'Vault',
    title: 'Vault requests refused',
    isChange: (ev) => ev === 'refused',
    labels: {
      get: 'Given',
      refused: 'REFUSED',
    },
  },
]

function line(svc: Service, e: Entry): string {
  const ev = String(e.event ?? '')
  const parts: string[] = []
  const add = (label: string, v: unknown) => {
    const s = Array.isArray(v) ? v.join(', ') : String(v ?? '').trim()
    if (s) parts.push(label ? `${label} ${s}` : s)
  }
  if (ev === 'state') {
    const reason = String(e.reason ?? '')
    add('', String(e.state ?? '') + (reason ? ` (${reason})` : ''))
  } else {
    add('', e.action)
    add('folder', e.folder)
    add('calendar', e.calendar)
    add('name', e.name)
    add('to', e.to)
    add('cc', e.cc)
    add('bcc', e.bcc)
    add('guests', e.guests)
    add('subject', e.subject ? `"${String(e.subject)}"` : '')
    add('ids', e.ids ?? e.id ?? e.draft_id)
    add('count', e.count)
    add('from', e.source)
    add('files', e.files)
    add('attachments', e.attachments)
    add('flags', e.flags)
    add('tool', e.tool)
    add('item', e.item)
    add('field', e.field)
    add('by', e.caller)
    add('rule:', e.rule)
    add('—', e.detail)
    add('queue', e.queue_id ?? e.request_id)
  }
  return `${e.ts ?? ''}  [${svc.label}] ${svc.labels[ev] ?? ev}  ${parts.join('; ')}`.trim()
}

export type Period = 'day' | 'week' | 'month' | 'all'
export type ServiceChoice = 'all' | Service['id']

export const PERIODS: Record<Period, string> = {
  day: 'Last 24 hours',
  week: 'Last 7 days',
  month: 'Last 30 days',
  all: 'Everything kept (up to 500 entries per service)',
}
const PERIOD_HOURS: Record<Period, number | null> = {
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  all: null,
}

/** "YYYY-MM-DD HH:MM" in UTC, the way the services' logs start each time. */
const logMinute = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export type ActivityReport = {
  /** One line of Markdown for the top of the result. */
  summary: string
  /** One collapsible section per service, then everything in time order. */
  sections: { name: string; text: string }[]
}

/** The report from each service's log (oldest entry first). */
export function activityReport(
  logs: Partial<Record<Service['id'], Entry[]>>,
  opts: {
    service?: ServiceChoice
    period?: Period
    changesOnly?: boolean
    now?: Date
  } = {},
): ActivityReport {
  const service = opts.service ?? 'all'
  const period = opts.period ?? 'all'
  const hours = PERIOD_HOURS[period]
  const cutoff =
    hours === null
      ? ''
      : logMinute(new Date((opts.now ?? new Date()).getTime() - hours * 3600e3))
  const inPeriod = (e: Entry) =>
    !cutoff || String(e.ts ?? '').slice(0, 16) >= cutoff
  const all: { svc: Service; e: Entry; n: number }[] = []
  const sections: { name: string; text: string }[] = []
  const counts: string[] = []
  for (const svc of SERVICES) {
    if (service !== 'all' && service !== svc.id) continue
    const entries = (logs[svc.id] ?? []).filter(inPeriod)
    const changes = entries.filter((e) => svc.isChange(String(e.event ?? '')))
    const shown = opts.changesOnly ? changes : entries
    shown.forEach((e, n) => all.push({ svc, e, n }))
    counts.push(
      `${svc.label} **${changes.length}** change${changes.length === 1 ? '' : 's'}` +
        (opts.changesOnly ? '' : ` in ${entries.length}`),
    )
    const newest = [...changes].reverse()
    sections.push({
      name: `${svc.title} (${newest.length})`,
      text: newest.length
        ? newest.map((e) => line(svc, e)).join('\n')
        : 'Nothing in this period.',
    })
  }
  // Newest first across all logs ("YYYY-MM-DD HH:MM UTC" sorts as text);
  // entries of the same minute keep each log's own order.
  all.sort((a, b) => {
    const ta = String(a.e.ts ?? '')
    const tb = String(b.e.ts ?? '')
    if (ta !== tb) return ta < tb ? 1 : -1
    if (a.svc !== b.svc) return a.svc.id < b.svc.id ? -1 : 1
    return b.n - a.n
  })
  sections.push({
    name: `${opts.changesOnly ? 'All changes' : 'Everything'}, newest first (${all.length})`,
    text: all.length
      ? all.map(({ svc, e }) => line(svc, e)).join('\n')
      : 'No activity in this period.',
  })
  return {
    summary: `${PERIODS[period]}: ${counts.join(' · ')}.`,
    sections,
  }
}

/** The whole report as one text (the download). */
export function activityText(
  logs: Partial<Record<Service['id'], Entry[]>>,
  opts: Parameters<typeof activityReport>[1] = {},
): string {
  const r = activityReport(logs, opts)
  return [
    r.summary.replace(/\*\*/g, ''),
    '',
    ...r.sections.flatMap((s) => [`${s.name}:`, s.text, '']),
  ].join('\n')
}

const { InputSpec, Value } = sdk

export const agentActivity = sdk.Action.withInput(
  'agent-activity',

  async () => ({
    name: 'Agent Activity',
    description:
      "The email, calendar, contacts and vault services' logs, newest first: what the agents read, filed, drafted, sent, added, changed and cancelled, what your rules refused or held for approval, your decisions, and which Vaultwarden items were given or refused. No message text, event descriptions or secrets are logged.",
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_DAILY,
    visibility: 'enabled',
  }),

  InputSpec.of({
    service: Value.select({
      name: 'Service',
      description: 'Which log to show.',
      default: 'all',
      values: {
        all: 'All services',
        mail: 'Email',
        calendar: 'Calendar',
        contacts: 'Contacts',
        vault: 'Vault',
      },
    }),
    period: Value.select({
      name: 'Period',
      description: 'How far back. Times in the logs are UTC.',
      default: 'week',
      values: PERIODS,
    }),
    changesOnly: Value.toggle({
      name: 'Changes Only',
      description:
        'Only what changed something or waited for you: mail sent, held or refused, calendar writes, the contacts service starting or reading the address book, vault refusals. Off: also every read, list and search.',
      default: false,
    }),
  }),

  async () => ({ service: 'all', period: 'week', changesOnly: false }) as any,

  async ({ effects, input }) => {
    const service = (
      ['all', ...SERVICES.map((s) => s.id)].includes(String(input.service))
        ? input.service
        : 'all'
    ) as ServiceChoice
    const period = (
      String(input.period) in PERIODS ? input.period : 'week'
    ) as Period
    const changesOnly = input.changesOnly === true
    const logs: Partial<Record<Service['id'], Entry[]>> = {}
    for (const svc of SERVICES) {
      if (service !== 'all' && service !== svc.id) continue
      const out = await agentctl(effects, ['activity', svc.id, '500'])
      logs[svc.id] = (out?.activity ?? []) as Entry[]
    }
    const opts = { service, period, changesOnly }
    const report = activityReport(logs, opts)
    return {
      version: '1' as const,
      title: 'Agent Activity',
      message: report.summary,
      result: {
        type: 'group' as const,
        value: [
          ...report.sections.map((s) => ({
            type: 'group' as const,
            name: s.name,
            description: null,
            value: [
              {
                type: 'multiline' as const,
                name: '',
                description: null,
                value: s.text,
                copyable: true,
              },
            ],
          })),
          {
            type: 'group' as const,
            name: 'Whole report (copy or download)',
            description: null,
            value: [
              {
                type: 'multiline' as const,
                name: '',
                description: null,
                value: activityText(logs, opts),
                copyable: true,
                filename: 'agent-activity.txt',
              },
            ],
          },
        ],
      },
    }
  },
)
