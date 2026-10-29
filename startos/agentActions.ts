import { T } from '@start9labs/start-sdk'
import { inOpenclawContainer } from './gatewayContainer'

// The approval queues of the package's isolated services (since
// 2026.10.1:14; mail only, so far). Each service keeps its own queue in its
// own folder (agentsvc/approvals.py); agentsvc/agentctl.py, run as root in
// the gateway's container, lists them together and records the owner's
// decisions. Review Agent Actions is the one place the owner decides, and
// one StartOS task stands for everything waiting, from every service.

export const AGENTCTL = '/opt/openclaw-services/agentctl.py'

/** The services agentctl knows, as named in its commands. */
export type AgentService = 'mail'

/** A request waiting for the owner, as agentctl shows it (common fields
 * only; never a service's private data such as a message's bytes). */
export type AgentAction = {
  id: string
  service: AgentService
  label: string
  action?: string
  summary?: string
  details?: string[]
  rule?: string
  requester?: string
  created?: number
  expires?: number
  decided?: boolean
  recipients?: string[]
}

/**
 * Run agentctl.py as root in the gateway's container (the queues and logs
 * belong to the service users; only root reads them there). JSON out.
 */
export async function agentctl(
  effects: T.Effects,
  args: string[],
): Promise<any> {
  const res = await inOpenclawContainer(effects, 'agentctl', (sub) =>
    sub.exec(['python3', '-I', AGENTCTL, ...args], {
      user: 'root',
      timeout: 30_000,
    }),
  )
  if (res.exitCode !== 0) {
    throw new Error(
      `The approval queue could not be read: ${String(res.stderr).trim().split('\n').pop() || `exit ${res.exitCode}`}`,
    )
  }
  return JSON.parse(String(res.stdout))
}

/** Everything still waiting for a decision, oldest first. */
export async function pendingAgentActions(
  effects: T.Effects,
): Promise<AgentAction[]> {
  const out = await agentctl(effects, ['queue'])
  return ((out?.queue ?? []) as AgentAction[]).filter((q) => !q.decided)
}

// ── The one StartOS task ────────────────────────────────────────────────────
//
// Each service's health check reports what it has waiting; the task is
// raised while anything waits anywhere and cleared when nothing does. A
// service whose check stops running (turned off) reports nothing, which
// counts as nothing waiting.

export const AGENT_ACTIONS_TASK = 'agent-actions'
/** Replay ids of tasks from earlier versions, cleared once per start. */
export const LEGACY_TASKS = ['mail-queue']

const waiting = new Map<string, string[]>()
let syncedKey: string | null = null

/** Record what one service has waiting. Returns the task change still to
 * make (then call taskSynced with its key once made), or null. */
export function agentActionsTaskChange(
  source: string,
  ids: string[],
): { key: string; total: number } | null {
  waiting.set(source, [...ids].sort())
  const key = [...waiting.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, xs]) => `${s}:${xs.join(',')}`)
    .join(';')
  if (key === syncedKey) return null
  const total = [...waiting.values()].reduce((n, xs) => n + xs.length, 0)
  return { key, total }
}

export function taskSynced(key: string) {
  syncedKey = key
}
