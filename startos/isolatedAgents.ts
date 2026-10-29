// The package's isolated agents: each is the only agent with one service's
// tools (mail, calendar) and has nothing else. None of them is ever the
// main (human-facing) agent, owns channels or the heartbeat, or is
// spawned by another agent.

export const ISOLATED_AGENT_IDS = ['email', 'calendar']

export const isIsolatedAgent = (id: string) => ISOLATED_AGENT_IDS.includes(id)

/** The main (human-facing) agent's id: the recorded system agent, else the
 * one configured agent that is not an isolated one, else "main". */
export function primaryAgentId(cfg: any): string {
  const sys = cfg?.agents?.defaults?.systemAgent?.agentId
  if (typeof sys === 'string' && sys && !isIsolatedAgent(sys)) return sys
  const ids = Object.keys(cfg?.agents?.entries ?? {}).filter(
    (id) => !isIsolatedAgent(id),
  )
  if (ids.length === 1) return ids[0]
  return 'main'
}

/**
 * The parts every isolated agent's wiring shares, applied to a copy of
 * openclaw.json: its service's tools denied for every other agent, nobody
 * allowed to spawn it, the primary agent's workspace pinned before a
 * second agent appears, and the system agent and heartbeat owned by the
 * primary agent.
 */
export function isolateAgent(
  c: any,
  agentId: string,
  toolsPattern: string,
  on: boolean,
) {
  const uniq = (xs: string[]) => Array.from(new Set(xs))
  c.agents = c.agents ?? {}
  c.agents.entries = c.agents.entries ?? {}
  const entries = c.agents.entries as Record<string, any>
  const primary = primaryAgentId(c)
  const humans = Object.keys(entries).filter((id) => !isIsolatedAgent(id))
  if (on && humans.length <= 1) {
    // The primary agent is the sole human-facing agent. A sole agent works
    // in agents.defaults.workspace (or OpenClaw's default); in a fleet, an
    // agent without its own `workspace` gets a folder of its own instead,
    // so adding an isolated agent would move the main agent's workspace
    // (identity, memory, files). Pin it where it is.
    const e = (entries[primary] = entries[primary] ?? {})
    if (!e.workspace) {
      e.workspace = c.agents.defaults?.workspace || '/data/.openclaw/workspace'
    }
  }
  for (const [id, e] of Object.entries(entries)) {
    if (id === agentId || !e || typeof e !== 'object') continue
    e.tools = e.tools ?? {}
    e.tools.deny = uniq([...(e.tools.deny ?? []), toolsPattern])
    // A spawned copy would inherit the spawner's deny and have no tools.
    const allow = e.subagents?.allowAgents
    if (Array.isArray(allow) && allow.includes(agentId)) {
      e.subagents.allowAgents = allow.filter((x: string) => x !== agentId)
    }
  }
  if (on) {
    // With a second agent the fleet is multi-agent, and OpenClaw no longer
    // picks "the sole agent" for channels, heartbeat and system work: they
    // need a named owner. Name the primary agent where nothing is set (an
    // owner chosen already is kept). An isolated agent never owns anything.
    const d = (c.agents.defaults = c.agents.defaults ?? {})
    if (!d.systemAgent?.agentId || isIsolatedAgent(d.systemAgent.agentId)) {
      d.systemAgent = { ...(d.systemAgent ?? {}), agentId: primary }
    }
    if (!d.heartbeat?.agentId || isIsolatedAgent(d.heartbeat.agentId)) {
      d.heartbeat = { ...(d.heartbeat ?? {}), agentId: primary }
    }
    c.agents.ownership = c.agents.ownership ?? 'explicit'
  }
  return primary
}
