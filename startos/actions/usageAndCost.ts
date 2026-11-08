import { sdk } from '../sdk'
import { agentctl } from '../agentActions'
import { usageSettingsJson } from '../fileModels/usageSettings.json'
import { GROUP_DAILY } from './groups'

// Usage and Cost (since 2026.10.1:30): what the models cost, per agent and
// per day, from OpenClaw's own records (agentctl.py usage: the cost OpenClaw
// computes for every model call with the provider's prices). Numbers only.
// Since :44: a one-line summary, collapsible sections, and each agent's
// model with the form that sets it.

type Window = {
  cost: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
type AgentRow = {
  agent: string
  model: string
  helper: boolean
  today: Window
  d7: Window
  d30: Window
}
export type Usage = {
  zone: string
  today: string
  total: { today: number; d7: number; d30: number }
  agents: AgentRow[]
  days: { date: string; cost: number; calls: number }[]
  jobs: {
    name: string
    schedule: string
    agent: string
    enabled: unknown
    runs7d: number
  }[]
  problems: string[]
}

export const dollars = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n > 0 ? `$${n.toFixed(2)}` : '$0'

const tokens = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n))

const pad = (s: string, n: number) =>
  s.length >= n ? s : s + ' '.repeat(n - s.length)
const padL = (s: string, n: number) =>
  s.length >= n ? s : ' '.repeat(n - s.length) + s

/** Which form sets an agent's model (since :44). */
export function modelSetIn(agent: string): string {
  switch (agent) {
    case 'main':
      return 'Configure AI Provider → Default Model'
    case 'email':
      return 'Configure Email → Email Agent Model'
    case 'calendar':
      return 'Configure Calendar → Calendar Agent Model'
    case 'contacts':
      return 'Configure Contacts → Contacts Agent Model'
    case 'apps':
      return 'Configure Apps Agent → Apps Agent Model'
    default:
      return 'Configure Agents → Model'
  }
}

export type UsageReport = {
  /** One line of Markdown for the top of the result. */
  summary: string
  sections: { name: string; text: string }[]
}

/** The action's report (exported for tests). */
export function usageReport(u: Usage, limit: number | null): UsageReport {
  const sections: { name: string; text: string }[] = []
  const agents: string[] = [
    `${pad('agent', 20)}${padL('7 days', 9)}${padL('share', 7)}${padL('today', 9)}${padL('30 days', 9)}${padL('calls', 7)}  tokens in / out / cache read / cache write`,
  ]
  for (const a of u.agents) {
    const share = u.total.d7 ? Math.round((a.d7.cost / u.total.d7) * 100) : 0
    agents.push(
      `${pad(a.agent + (a.helper ? ' *' : ''), 20)}${padL(dollars(a.d7.cost), 9)}${padL(share + '%', 7)}${padL(dollars(a.today.cost), 9)}${padL(dollars(a.d30.cost), 9)}${padL(String(a.d7.calls), 7)}  ${tokens(a.d7.input)} / ${tokens(a.d7.output)} / ${tokens(a.d7.cacheRead)} / ${tokens(a.d7.cacheWrite)}`,
    )
  }
  const helpers = u.agents.filter((a) => a.helper)
  if (helpers.length) {
    const h = helpers.reduce((s, a) => s + a.d7.cost, 0)
    agents.push(
      `* the package's helper agents (email, calendar, contacts, apps) together: ${dollars(h)} in 7 days (${u.total.d7 ? Math.round((h / u.total.d7) * 100) : 0}%).`,
    )
  }
  if (!u.agents.length) agents.push('No model calls in the last 30 days.')
  sections.push({ name: 'Per agent, last 7 days', text: agents.join('\n') })
  if (u.agents.length)
    sections.push({
      name: 'Models, and where each is set',
      text: u.agents
        .map(
          (a) =>
            `${pad(a.agent, 20)}${pad(a.model || '?', 34)} ${modelSetIn(a.agent)}`,
        )
        .join('\n'),
    })
  const max = Math.max(...u.days.map((d) => d.cost), 0.01)
  sections.push({
    name: 'Per day, last 14 days',
    text: u.days
      .map(
        (d) =>
          `${d.date}  ${padL(dollars(d.cost), 8)}  ${padL(String(d.calls), 5)} calls  ${'█'.repeat(Math.round((d.cost / max) * 30))}${limit && d.cost > limit ? '  over the alert' : ''}`,
      )
      .join('\n'),
  })
  if (u.jobs.length)
    sections.push({
      name: `Scheduled jobs (${u.jobs.length})`,
      text:
        'Runs in the last 7 days; their cost is in the agent that runs them.\n' +
        u.jobs
          .map(
            (j) =>
              `${padL(String(j.runs7d), 5)}  ${pad(j.name, 40)} ${pad(j.schedule || '', 22)} agent ${j.agent || '?'}${j.enabled === 0 || j.enabled === false ? ' (off)' : ''}`,
          )
          .join('\n'),
    })
  sections.push({
    name: 'How to lower it',
    text:
      'A cheaper model for an agent (the forms are listed under "Models, and where each is set"); fewer or less frequent scheduled jobs.\nMost of the cost is usually cache writes: each call re-sends the agent\'s instructions and conversation.' +
      (u.problems.length ? '\n\nCould not read: ' + u.problems.join('; ') : ''),
  })
  const top = u.agents[0]
  return {
    summary:
      `Today **${dollars(u.total.today)}** · last 7 days **${dollars(u.total.d7)}** (${dollars(u.total.d7 / 7)} a day) · last 30 days **${dollars(u.total.d30)}**` +
      (limit ? ` · alert above ${dollars(limit)} a day` : '') +
      (top && u.total.d7
        ? ` · most: ${top.agent} (${Math.round((top.d7.cost / u.total.d7) * 100)}%)`
        : '') +
      (u.problems.length ? ' · some records could not be read' : '') +
      '.',
    sections,
  }
}

/** The whole report as one text (the download; exported for tests). */
export function usageText(u: Usage, limit: number | null): string {
  const r = usageReport(u, limit)
  return [
    `Model cost from OpenClaw's own records (provider prices), days in ${u.zone}.`,
    r.summary.replace(/\*\*/g, ''),
    '',
    ...r.sections.flatMap((s) => [`${s.name}:`, s.text, '']),
  ].join('\n')
}

export async function readUsage(effects: any): Promise<Usage> {
  return (await agentctl(effects, ['usage', '30'])) as Usage
}

export const usageAndCost = sdk.Action.withoutInput(
  'usage-and-cost',

  async () => ({
    name: 'Usage and Cost',
    description:
      "What the AI models cost: per agent (today, 7 and 30 days, tokens, model), per day for the last two weeks, and how often each scheduled job ran. From the cost OpenClaw records for every model call with the provider's prices. Numbers only, no message text.",
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_DAILY,
    visibility: 'enabled',
  }),

  async ({ effects }) => {
    const u = await readUsage(effects)
    const limit =
      (await usageSettingsJson
        .read((s) => s.dailyLimit)
        .once()
        .catch(() => null)) ?? null
    const report = usageReport(u, limit)
    const section = (name: string, text: string, filename?: string) => ({
      type: 'group' as const,
      name,
      description: null,
      value: [
        {
          type: 'multiline' as const,
          name: '',
          description: null,
          value: text,
          copyable: true,
          ...(filename ? { filename } : {}),
        },
      ],
    })
    return {
      version: '1' as const,
      title: 'Usage and Cost',
      message: report.summary + `\nDays in ${u.zone}.`,
      result: {
        type: 'group' as const,
        value: [
          ...report.sections.map((s) => section(s.name, s.text)),
          section(
            'Whole report (copy or download)',
            usageText(u, limit),
            'usage-and-cost.txt',
          ),
        ],
      },
    }
  },
)

const { InputSpec, Value } = sdk

export const spendingAlert = sdk.Action.withInput(
  'spending-alert',

  async () => ({
    name: 'Spending Alert',
    description:
      'A daily limit for the model cost. Above it, the Spending line on the service page turns red and you get one StartOS notification (and ntfy, when set up) that day. Leave blank for no alert.',
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_DAILY,
    visibility: 'enabled',
  }),

  InputSpec.of({
    dailyLimit: Value.number({
      name: 'Daily Limit (US dollars)',
      description:
        "Alert when a day's model cost goes above this. Usage and Cost shows what a normal day costs. Blank: no alert.",
      required: false,
      default: null,
      min: 0.01,
      max: 100000,
      step: 0.01,
      integer: false,
      units: 'USD',
      placeholder: '5',
    }),
  }),

  async () => ({
    dailyLimit:
      (await usageSettingsJson
        .read((s) => s.dailyLimit)
        .once()
        .catch(() => null)) ?? null,
  }),

  async ({ effects, input }) => {
    const limit =
      typeof input.dailyLimit === 'number' && input.dailyLimit > 0
        ? Math.round(input.dailyLimit * 100) / 100
        : null
    await usageSettingsJson.write(effects, { dailyLimit: limit })
    return {
      version: '1' as const,
      title: 'Spending Alert',
      message: limit
        ? `Saved: an alert when a day costs more than ${dollars(limit)}. The Spending line shows it within 10 minutes.`
        : 'Saved: no spending alert.',
      result: null,
    }
  },
)
