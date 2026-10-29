import { sdk } from '../sdk'
import { agentctl } from '../agentActions'

// Email Activity (since 2026.10.1:10): the mail service's log, newest
// first: what the email agent read, filed, drafted and sent, what the rules
// refused or held, and the owner's decisions. No message bodies are logged.

type Entry = Record<string, unknown> & { ts?: string; event?: string }

const LABELS: Record<string, string> = {
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
}

function line(e: Entry): string {
  const ev = String(e.event ?? '')
  const parts: string[] = []
  const add = (label: string, v: unknown) => {
    const s = Array.isArray(v) ? v.join(', ') : String(v ?? '').trim()
    if (s) parts.push(`${label} ${s}`)
  }
  if (ev === 'state') {
    const reason = String(e.reason ?? '')
    add('', String(e.state ?? '') + (reason ? ` (${reason})` : ''))
  } else {
    add('folder', e.folder)
    add('to', e.to)
    add('cc', e.cc)
    add('bcc', e.bcc)
    add('subject', e.subject ? `"${String(e.subject)}"` : '')
    add('ids', e.ids ?? e.id ?? e.draft_id)
    add('count', e.count)
    add('files', e.files)
    add('attachments', e.attachments)
    add('rule:', e.rule)
    add('—', e.detail)
    add('queue', e.queue_id)
  }
  return `${e.ts ?? ''}  ${LABELS[ev] ?? ev}  ${parts.join('; ')}`.trim()
}

export const emailActivity = sdk.Action.withoutInput(
  'email-activity',

  async () => ({
    name: 'Email Activity',
    description:
      "The mail service's log, newest first: what the email agent read, filed, drafted and sent, what your rules refused or held for approval, and your decisions. No message text is logged.",
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const out = await agentctl(effects, ['activity', 'mail', '300'])
    const entries = ((out?.activity ?? []) as Entry[]).reverse()
    const sends = entries.filter((e) =>
      String(e.event ?? '').startsWith('send_'),
    )
    const text = [
      sends.length
        ? `Sending (last ${sends.length}):\n` + sends.map(line).join('\n')
        : 'Sending: nothing yet.',
      '',
      'Everything (newest first):',
      entries.length ? entries.map(line).join('\n') : 'No activity yet.',
    ].join('\n')
    return {
      version: '1' as const,
      title: 'Email Activity',
      message: null,
      result: {
        type: 'multiline' as const,
        name: 'Log',
        description: null,
        value: text,
        copyable: true,
        filename: 'email-activity.txt',
      },
    }
  },
)
