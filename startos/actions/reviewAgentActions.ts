import { sdk } from '../sdk'
import { emailSettingsJson, Mailing } from '../fileModels/emailSettings.json'
import {
  mailingId,
  mailingNameFromSubject,
  sendingOf,
  writeEmailSettings,
} from '../mailService'
import { AgentAction, agentctl, pendingAgentActions } from '../agentActions'
import { GROUP_DAILY } from './groups'
import { agentActionsWaitingJson } from '../fileModels/agentActionsWaiting.json'

const { InputSpec, Value, Variants } = sdk

// Review Agent Actions (since 2026.10.1:14; Review Outgoing Mail from :10):
// approve or reject what an isolated agent wanted to do that the owner's
// rules hold for approval. So far that is mail the email agent wants to
// send (Configure Email → Sending). Each service keeps the exact request in
// its own queue; this records the decision (agentsvc/agentctl.py) and the
// service acts on it within seconds. For mail, "Approve and always allow"
// also adds the recipients to Send Automatically To, and (since :22)
// "Approve and make this a routine mailing" saves the mail's recipients,
// subject start and attachment types as a routine mailing (Configure Email)
// and sends this one as its first, approved issue.

/** The routine mailing made from a waiting mail (exported for tests). */
export function mailingFromItem(q: AgentAction, prior?: Mailing): Mailing {
  const seed = q.mailingSeed ?? {}
  if (seed.kind !== 'new')
    throw new Error(
      'Only a new message can become a routine mailing (not a reply or forward).',
    )
  const prefix = mailingNameFromSubject(seed.subject ?? '')
  if (!prefix)
    throw new Error('This mail has no subject to recognise the mailing by.')
  const name = (seed.name || prior?.name || prefix).trim()
  return {
    name,
    to: seed.to ?? [],
    cc: seed.cc ?? [],
    bcc: seed.bcc ?? [],
    subjectPrefix: prefix,
    perMonth: prior?.perMonth ?? 1,
    attachmentTypes: seed.attachmentTypes ?? [],
    linkDomains: prior?.linkDomains ?? [],
    paused: false,
  }
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

function details(q: AgentAction): string {
  return [
    ...(q.details ?? []),
    `Why it waits: ${q.rule || '—'}`,
    `Requested by: ${q.requester || `${q.label.toLowerCase()} agent`}, ${when(q.created)}; expires ${when(q.expires)}`,
  ].join('\n')
}

const title = (q: AgentAction) => `[${q.label}] ${oneLine(q.summary, 90)}`

/** The form's key for a waiting item (service and id are word characters). */
export const itemKey = (q: AgentAction) => `${q.service}_${q.id}`

/** Why an item cannot become a routine mailing, or null when it can. */
export function routineBlocked(q: AgentAction): string | null {
  const seed = q.mailingSeed ?? {}
  if (seed.kind === 'invite') return 'an invitation is never a routine mailing'
  if (seed.kind !== 'new')
    return 'only a new message can be one, not a reply or forward'
  if (!mailingNameFromSubject(seed.subject ?? ''))
    return 'this mail has no subject to recognise the mailing by'
  return null
}

/**
 * The decision for one waiting item (since :38): only the choices that
 * apply to it, none picked in advance, its details shown under the field.
 * Exported for tests.
 */
export function decisionFor(q: AgentAction) {
  const isMail = q.service === 'mail'
  const blocked = isMail ? routineBlocked(q) : null
  const values: Record<string, string> = isMail
    ? {
        approve: 'Approve: send it',
        reject: 'Reject: do not send it (the draft stays in Drafts)',
        always: 'Approve, and always send to these recipients without asking',
        routine: 'Approve, and make this a routine mailing',
      }
    : {
        approve: 'Approve: carry it out',
        reject: 'Reject: do not carry it out',
      }
  return Value.dynamicSelect(async () => ({
    name: 'Decision',
    description: isMail
      ? 'Always send: the recipients are added to Send Automatically To (Configure Email); forwards, attachments and HTML mail are still held. Routine mailing: its recipients, the start of its subject and its attachment types are saved under Configure Email → Sending → Routine Mailings, at most 1 a month to begin with; later issues that match go out without asking.' +
        (blocked ? `\n\nRoutine mailing is not offered: ${blocked}.` : '')
      : null,
    footnote: details(q),
    default: null,
    values,
    disabled: blocked ? ['routine'] : false,
  }))
}

/** One choice per waiting item, keyed by itemKey. */
type RequestVariants = Record<string, { name: string; spec: any }>

const inputSpec = InputSpec.of({
  request: Value.dynamicUnion(async ({ effects }) => {
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
        disabled: false,
        variants: Variants.of<RequestVariants>({
          none: { name: 'Nothing is waiting', spec: InputSpec.of({}) },
        }),
      }
    }
    return {
      name: 'Request',
      description:
        items.length > 1
          ? `${items.length} requests wait, oldest first. Pick one; its details are shown under its Decision.`
          : null,
      default: itemKey(items[0]),
      disabled: false,
      variants: Variants.of<RequestVariants>(
        Object.fromEntries(
          items.map((q, n) => [
            itemKey(q),
            {
              name: `${n + 1}. ${title(q)}`,
              spec: InputSpec.of({ decision: decisionFor(q) }),
            },
          ]),
        ),
      ),
    }
  }),
})

export const reviewAgentActions = sdk.Action.withInput(
  'review-agent-actions',

  async ({ effects }) => {
    // Greyed out while the health checks say nothing waits (written with
    // the task, fileModels/agentActionsWaiting.json); open when unknown.
    const waiting = await agentActionsWaitingJson
      .read((s) => s.waiting)
      .const(effects)
      .catch(() => null)
    return {
      name: 'Review Agent Actions',
      description:
        'Approve or reject what your agents want to do that your rules hold for you, such as mail the email agent wants to send (Configure Email → Sending). Shows what would happen, to whom, and why it was held. Undecided requests expire after 5 days, with a reminder the day before.',
      warning: null,
      allowedStatuses: 'any' as const,
      group: GROUP_DAILY,
      visibility:
        waiting === 0
          ? {
              disabled:
                'Nothing is waiting for approval. When an agent asks, a task appears on this service.',
            }
          : ('enabled' as const),
    }
  },

  inputSpec,

  async () => ({}) as any,

  async ({ effects, input }) => {
    const req = (input as any)?.request ?? {}
    const key = String(req.selection ?? '')
    const choice = String(req.value?.decision ?? '')
    if (!key || key === 'none') {
      return {
        version: '1' as const,
        title: 'Nothing to Review',
        message: 'Nothing is waiting for approval.',
        result: null,
      }
    }
    const items = await pendingAgentActions(effects)
    const q = items.find((x) => itemKey(x) === key)
    if (!q) {
      throw new Error(
        'That request is no longer waiting (it was decided, done, or expired). Agent Activity shows what happened to it.',
      )
    }
    // Guards only: the form offers exactly these choices.
    const isMailItem = q.service === 'mail'
    const allowed = isMailItem
      ? ['approve', 'reject', 'always', 'routine']
      : ['approve', 'reject']
    if (!allowed.includes(choice))
      throw new Error('Pick a decision for this request.')
    if (choice === 'routine') {
      const blocked = routineBlocked(q)
      if (blocked)
        throw new Error(`This cannot become a routine mailing: ${blocked}.`)
    }
    const decision = choice === 'reject' ? 'reject' : 'approve'
    let added: string[] = []
    if (choice === 'always' && q.service === 'mail') {
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
    let made: Mailing | null = null
    if (choice === 'routine' && q.service === 'mail') {
      const s = await emailSettingsJson.read().once()
      if (!s) throw new Error('Configure Email has no settings yet.')
      const sending = sendingOf(s)
      const list = sending.mailings ?? []
      const seedId = mailingId(
        q.mailingSeed?.name ||
          q.mailingSeed?.mailing ||
          mailingNameFromSubject(q.mailingSeed?.subject ?? ''),
      )
      const prior = list.find((m) => mailingId(m.name) === seedId)
      made = mailingFromItem(q, prior)
      await writeEmailSettings(effects, {
        ...s,
        sending: {
          ...sending,
          mailings: [
            ...list.filter((m) => mailingId(m.name) !== mailingId(made!.name)),
            made,
          ],
        },
      })
    }
    const res = await agentctl(effects, [
      'decide',
      q.service,
      q.id,
      decision,
      ...(made ? [mailingId(made.name)] : []),
    ])
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
            (made
              ? ` Saved as the routine mailing "${made.name}": to ${[...made.to, ...made.cc.map((x) => `${x} (Cc)`), ...made.bcc.map((x) => `${x} (Bcc)`)].join(', ')}; subject starting "${made.subjectPrefix}"; at most ${made.perMonth} a month; attachments: ${made.attachmentTypes.join(', ') || 'none'}. Change it in Configure Email → Sending → Routine Mailings.`
              : '') +
            ' Agent Activity shows the outcome.'
          : isMail
            ? `${what} will not be sent. The draft stays in Drafts.`
            : `${what} will not be carried out.`,
      result: null,
    }
  },
)
