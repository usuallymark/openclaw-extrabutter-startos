import { sdk } from '../sdk'
import { emailSettingsJson } from '../fileModels/emailSettings.json'
import { sendingOf, writeEmailSettings } from '../mailService'
import { AgentAction, agentctl, pendingAgentActions } from '../agentActions'

const { InputSpec, Value } = sdk

// Review Agent Actions (since 2026.10.1:14; Review Outgoing Mail from :10):
// approve or reject what an isolated agent wanted to do that the owner's
// rules hold for approval. So far that is mail the email agent wants to
// send (Configure Email → Sending). Each service keeps the exact request in
// its own queue; this records the decision (agentsvc/agentctl.py) and the
// service acts on it within seconds. For mail, "Approve and always allow"
// also adds the recipients to Send Automatically To.

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

function details(q: AgentAction): string {
  return [
    ...(q.details ?? []),
    `Why it waits: ${q.rule || '—'}`,
    `Requested by: ${q.requester || `${q.label.toLowerCase()} agent`}, ${when(q.created)}; expires ${when(q.expires)}`,
  ].join('\n')
}

const title = (q: AgentAction) => `[${q.label}] ${oneLine(q.summary, 90)}`

const inputSpec = InputSpec.of({
  item: Value.dynamicSelect(async ({ effects }) => {
    let items: AgentAction[] = []
    let error = ''
    try {
      items = await pendingAgentActions(effects)
    } catch (e) {
      error = (e as Error).message
    }
    if (!items.length) {
      return {
        name: 'Request',
        description: error || 'Nothing is waiting for approval.',
        default: 'none',
        values: { none: 'Nothing is waiting' },
        disabled: ['none'],
      }
    }
    return {
      name: 'Request',
      description: items
        .map((q, n) => `${n + 1}. ${title(q)}\n${details(q)}`)
        .join('\n\n'),
      default: `${items[0].service}/${items[0].id}`,
      values: Object.fromEntries(
        items.map((q, n) => [`${q.service}/${q.id}`, `${n + 1}. ${title(q)}`]),
      ),
    }
  }),
  decision: Value.select({
    name: 'Decision',
    description:
      'Approve: carry it out now. Reject: do not (for mail, the draft stays in Drafts). Approve and always allow (email only): send it, and add its recipients to Send Automatically To (Configure Email), so mail to them is no longer held for approval; forwards and attachments are always held. For anything else it is the same as Approve.',
    default: 'approve',
    values: {
      approve: 'Approve',
      reject: 'Reject',
      always: 'Approve and always allow these recipients (email)',
    },
  }),
})

export const reviewAgentActions = sdk.Action.withInput(
  'review-agent-actions',

  async () => ({
    name: 'Review Agent Actions',
    description:
      'Approve or reject what your agents want to do that your rules hold for you, such as mail the email agent wants to send (Configure Email → Sending). Shows what would happen, to whom, and why it was held. Undecided requests expire after 3 days.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => ({}) as any,

  async ({ effects, input }) => {
    const i = input as any
    const key = String(i.item ?? '')
    if (!key || key === 'none') {
      return {
        version: '1' as const,
        title: 'Nothing to Review',
        message: 'Nothing is waiting for approval.',
        result: null,
      }
    }
    const items = await pendingAgentActions(effects)
    const q = items.find((x) => `${x.service}/${x.id}` === key)
    if (!q) {
      throw new Error(
        'That request is no longer waiting (it was decided, done, or expired). Email Activity shows what happened to mail.',
      )
    }
    const decision = i.decision === 'reject' ? 'reject' : 'approve'
    let added: string[] = []
    if (i.decision === 'always' && q.service === 'mail') {
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
    const res = await agentctl(effects, ['decide', q.service, q.id, decision])
    if (!res?.ok)
      throw new Error(res?.error || 'The decision was not recorded.')
    const what = `"${oneLine(q.summary, 80)}"`
    const isMail = q.service === 'mail'
    return {
      version: '1' as const,
      title: decision === 'approve' ? 'Approved' : 'Rejected',
      message:
        decision === 'approve'
          ? (isMail
              ? `${what} will be sent within a minute.`
              : `${what} will be carried out within a minute.`) +
            (added.length
              ? ` Added to Send Automatically To: ${added.join(', ')}.`
              : '') +
            (isMail ? ' Email Activity shows the outcome.' : '')
          : isMail
            ? `${what} will not be sent. The draft stays in Drafts.`
            : `${what} will not be carried out.`,
      result: null,
    }
  },
)
