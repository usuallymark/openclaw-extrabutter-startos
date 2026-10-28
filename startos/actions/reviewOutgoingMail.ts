import { sdk } from '../sdk'
import { emailSettingsJson } from '../fileModels/emailSettings.json'
import { mailctl, sendingOf, writeEmailSettings } from '../mailService'

const { InputSpec, Value } = sdk

// Review Outgoing Mail (since 2026.10.1:10): approve or reject a message the
// email agent wanted to send that the rules hold for the owner (Configure
// Email → Sending). The mail service keeps the exact message in its queue;
// this records the decision (mail/mailctl.py) and the service acts on it
// within seconds. "Approve and always allow" also adds the recipients to
// Send Automatically To.

export const MAIL_QUEUE_TASK = 'mail-queue'

type Item = {
  id: string
  kind?: string
  rule?: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  opening?: string
  attachments?: string[]
  requester?: string
  created?: number
  expires?: number
  decided?: boolean
  recipients?: string[]
}

const when = (t?: number) =>
  t
    ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    : ''

const oneLine = (s: unknown, n: number) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function details(q: Item): string {
  const lines = [
    `To: ${q.to || '—'}`,
    ...(q.cc ? [`Cc: ${q.cc}`] : []),
    ...(q.bcc ? [`Bcc: ${q.bcc}`] : []),
    `Subject: ${q.subject || '(none)'}`,
    `Kind: ${q.kind === 'forward' ? 'forward' : q.kind?.startsWith('reply') ? 'reply' : 'new message'}`,
    `Attachments: ${q.attachments?.length ? q.attachments.join(', ') : 'none'}`,
    `Why it waits: ${q.rule || '—'}`,
    `Requested by: ${q.requester || 'email agent'}, ${when(q.created)}; expires ${when(q.expires)}`,
    `Opening lines: ${oneLine(q.opening, 400) || '(empty)'}`,
  ]
  return lines.join('\n')
}

async function pending(effects: any): Promise<Item[]> {
  const out = await mailctl(effects, ['queue'])
  return ((out?.queue ?? []) as Item[]).filter((q) => !q.decided)
}

const inputSpec = InputSpec.of({
  item: Value.dynamicSelect(async ({ effects }) => {
    let items: Item[] = []
    let error = ''
    try {
      items = await pending(effects)
    } catch (e) {
      error = (e as Error).message
    }
    if (!items.length) {
      return {
        name: 'Message',
        description: error || 'Nothing is waiting for approval.',
        default: 'none',
        values: { none: 'Nothing is waiting' },
        disabled: ['none'],
      }
    }
    return {
      name: 'Message',
      description: items
        .map((q, n) => `${n + 1}. ${oneLine(q.subject, 80)}\n${details(q)}`)
        .join('\n\n'),
      default: items[0].id,
      values: Object.fromEntries(
        items.map((q, n) => [
          q.id,
          `${n + 1}. To ${oneLine(q.recipients?.join(', ') || q.to, 60)}: ${oneLine(q.subject, 50)}`,
        ]),
      ),
    }
  }),
  decision: Value.select({
    name: 'Decision',
    description:
      'Approve: send it now. Reject: do not send (the draft stays in Drafts). Approve and always allow: send it, and add its recipients to Send Automatically To (Configure Email), so mail to them is no longer held for approval. Forwards and attachments are always held.',
    default: 'approve',
    values: {
      approve: 'Approve',
      reject: 'Reject',
      always: 'Approve and always allow these recipients',
    },
  }),
})

export const reviewOutgoingMail = sdk.Action.withInput(
  'review-outgoing-mail',

  async () => ({
    name: 'Review Outgoing Mail',
    description:
      'Approve or reject mail the email agent wants to send that your rules hold for you (Configure Email → Sending). Shows the recipients, subject, opening lines, attachments and why it was held. Undecided messages expire after 3 days.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => ({}) as any,

  async ({ effects, input }) => {
    const i = input as any
    const id = String(i.item ?? '')
    if (!id || id === 'none') {
      return {
        version: '1' as const,
        title: 'Nothing to Review',
        message: 'No mail is waiting for approval.',
        result: null,
      }
    }
    const items = await pending(effects)
    const q = items.find((x) => x.id === id)
    if (!q) {
      throw new Error(
        'That message is no longer waiting (it was decided, sent, or expired). Open Email Activity to see what happened.',
      )
    }
    const decision = i.decision === 'reject' ? 'reject' : 'approve'
    let added: string[] = []
    if (i.decision === 'always') {
      const s = await emailSettingsJson
        .read()
        .once()
        .catch(() => null)
      if (s) {
        const sending = sendingOf(s)
        const have = new Set(
          [
            ...sending.autoTo,
            ...(sending.includeTrusted ? (s.agent?.trustedSenders ?? []) : []),
          ].map((x) => x.toLowerCase()),
        )
        const never = sending.neverTo.map((x) => x.toLowerCase())
        added = (q.recipients ?? []).filter(
          (r) =>
            !have.has(r) &&
            !never.some((n) => r === n || (n.startsWith('@') && r.endsWith(n))),
        )
        if (added.length) {
          await writeEmailSettings(effects, {
            ...s,
            sending: { ...sending, autoTo: [...sending.autoTo, ...added] },
          })
        }
      }
    }
    const res = await mailctl(effects, ['decide', id, decision])
    if (!res?.ok)
      throw new Error(res?.error || 'The decision was not recorded.')
    return {
      version: '1' as const,
      title: decision === 'approve' ? 'Approved' : 'Rejected',
      message:
        decision === 'approve'
          ? `"${oneLine(q.subject, 80)}" will be sent within a minute.` +
            (added.length
              ? ` Added to Send Automatically To: ${added.join(', ')}.`
              : '') +
            ' Email Activity shows the outcome.'
          : `"${oneLine(q.subject, 80)}" will not be sent. The draft stays in Drafts.`,
      result: null,
    }
  },
)
