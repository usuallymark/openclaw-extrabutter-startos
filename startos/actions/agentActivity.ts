import { sdk } from '../sdk'
import { agentctl } from '../agentActions'

// Agent Activity (since 2026.10.1:18; Email Activity before): the isolated
// services' logs, newest first: what the email and calendar agents read,
// filed, drafted, sent, added, changed and cancelled, what the rules refused
// or held, and the owner's decisions. Neither log holds message text or
// event descriptions.

type Entry = Record<string, unknown> & { ts?: string; event?: string }

type Service = {
  id: 'mail' | 'calendar'
  label: string
  /** Events that changed something or waited for the owner. */
  isChange: (ev: string) => boolean
  labels: Record<string, string>
}

const SERVICES: Service[] = [
  {
    id: 'mail',
    label: 'Email',
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
      send_expired: 'Expired (not decided in 3 days)',
      send_cancelled: 'Cancelled (draft changed or gone)',
      send_failed: 'Sending failed',
      send_retry: 'Sending failed, will retry',
      auth_refused: 'Password refused by the mailbox',
      error: 'Tool error',
    },
  },
  {
    id: 'calendar',
    label: 'Calendar',
    isChange: (ev) => ev.startsWith('write_') || ev.startsWith('own_calendar'),
    labels: {
      state: 'Calendar service',
      sign_in_refused: 'Sign-in refused by Google',
      calendars: 'Listed calendars',
      list: 'Listed events',
      search: 'Searched',
      read: 'Read event',
      own_calendar_created: 'Own calendar created',
      own_calendar_gone: 'Own calendar missing',
      write_done: 'DONE',
      write_queued: 'Held for approval',
      write_rejected: 'Rejected by you',
      write_expired: 'Expired (not decided in time)',
      write_refused: 'Refused',
      write_failed: 'Failed',
      queue_error: 'Approval queue error',
      error: 'Tool error',
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
    add('files', e.files)
    add('attachments', e.attachments)
    add('flags', e.flags)
    add('tool', e.tool)
    add('rule:', e.rule)
    add('—', e.detail)
    add('queue', e.queue_id ?? e.request_id)
  }
  return `${e.ts ?? ''}  [${svc.label}] ${svc.labels[ev] ?? ev}  ${parts.join('; ')}`.trim()
}

/** The action's text from each service's log (oldest entry first). */
export function activityText(
  logs: Partial<Record<Service['id'], Entry[]>>,
): string {
  const all: { svc: Service; e: Entry; n: number }[] = []
  const sections: string[] = []
  for (const svc of SERVICES) {
    const entries = logs[svc.id] ?? []
    entries.forEach((e, n) => all.push({ svc, e, n }))
    const changes = entries
      .filter((e) => svc.isChange(String(e.event ?? '')))
      .reverse()
    const title = svc.id === 'mail' ? 'Email sending' : 'Calendar changes'
    sections.push(
      changes.length
        ? `${title} (last ${changes.length}):\n` +
            changes.map((e) => line(svc, e)).join('\n')
        : `${title}: nothing yet.`,
    )
  }
  // Newest first across both logs ("YYYY-MM-DD HH:MM UTC" sorts as text);
  // entries of the same minute keep each log's own order.
  all.sort((a, b) => {
    const ta = String(a.e.ts ?? '')
    const tb = String(b.e.ts ?? '')
    if (ta !== tb) return ta < tb ? 1 : -1
    if (a.svc !== b.svc) return a.svc.id < b.svc.id ? -1 : 1
    return b.n - a.n
  })
  return [
    ...sections.flatMap((s) => [s, '']),
    'Everything (newest first):',
    all.length
      ? all.map(({ svc, e }) => line(svc, e)).join('\n')
      : 'No activity yet.',
  ].join('\n')
}

export const agentActivity = sdk.Action.withoutInput(
  'agent-activity',

  async () => ({
    name: 'Agent Activity',
    description:
      "The email and calendar services' logs, newest first: what the agents read, filed, drafted, sent, added, changed and cancelled, what your rules refused or held for approval, and your decisions. No message text or event descriptions are logged.",
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const logs: Partial<Record<Service['id'], Entry[]>> = {}
    for (const svc of SERVICES) {
      const out = await agentctl(effects, ['activity', svc.id, '300'])
      logs[svc.id] = (out?.activity ?? []) as Entry[]
    }
    const text = activityText(logs)
    return {
      version: '1' as const,
      title: 'Agent Activity',
      message: null,
      result: {
        type: 'multiline' as const,
        name: 'Log',
        description: null,
        value: text,
        copyable: true,
        filename: 'agent-activity.txt',
      },
    }
  },
)
