import { readFile, writeFile } from 'fs/promises'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { openclawJson } from '../fileModels/openclaw.json'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import { mainMounts, OPENCLAW_CLI_ENV } from '../utils'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'

const { InputSpec, Value } = sdk

// Configure Agents: OpenClaw's own `agents.entries` (the helper agents the
// main agent can spawn), shown as a list. There is no package copy of the
// roster: the form is filled from openclaw.json every time it opens, and
// saving applies only what was changed in the form, through the same helper
// the agent uses (/opt/skills/agents/agents.py, OpenClaw's validated writer).
// So agents the main agent creates in conversation appear here, and one it
// changes while this form is open keeps that change unless the same field is
// edited here. The main agent is not a row: its model is Configure AI
// Provider, and "Main agent can spawn" on each row sets its spawn list.

const MAIN = 'main'
const HELPER = '/opt/skills/agents/agents.py'
// What the form showed when it was opened, to tell edits from untouched rows.
const SNAPSHOT = sdk.volumes.main.subpath('.startos/agents-form.json')

type Row = {
  id: string
  name: string | null
  model: string
  profile: string
  extraTools: string | null
  blockedTools: string | null
  skills: string | null
  canSpawn: string | null
  mainCanSpawn: boolean
  workspace: string | null
}

// ── Reading the live config ─────────────────────────────────────────────────

async function liveConfig(): Promise<any> {
  return ((await openclawJson
    .read()
    .once()
    .catch(() => undefined)) ?? {}) as any
}

const entriesOf = (cfg: any): Record<string, any> =>
  (cfg?.agents?.entries ?? {}) as Record<string, any>

const modelRef = (e: any): string =>
  (typeof e?.model === 'string' ? e.model : e?.model?.primary) || 'default'

const csv = (v: unknown) =>
  Array.isArray(v) ? (v as unknown[]).map(String).join(', ') : ''

export function rowsFrom(cfg: any): Row[] {
  const ents = entriesOf(cfg)
  const mainAllow: string[] = ents[MAIN]?.subagents?.allowAgents ?? []
  return Object.keys(ents)
    .filter((id) => id !== MAIN)
    .sort()
    .map((id) => {
      const e = ents[id] ?? {}
      const tools = e.tools ?? {}
      return {
        id,
        name: e.name ?? null,
        model: modelRef(e),
        profile: tools.profile ?? 'inherit',
        extraTools: csv(tools.alsoAllow ?? tools.allow) || null,
        blockedTools: csv(tools.deny) || null,
        skills:
          e.skills === undefined
            ? 'all'
            : (e.skills as unknown[]).length
              ? csv(e.skills)
              : 'none',
        canSpawn: csv(e.subagents?.allowAgents) || null,
        mainCanSpawn: mainAllow.includes('*') || mainAllow.includes(id),
        workspace: e.workspace ?? null,
      }
    })
}

// ── The form ────────────────────────────────────────────────────────────────

const PROFILES = {
  minimal: i18n('Minimal: almost no tools (add what it needs below)'),
  messaging: i18n('Messaging: session and conversation tools'),
  coding: i18n('Coding: files, shell, web, memory, sessions'),
  full: i18n('Full: every tool (no restriction)'),
  inherit: i18n('Same as the main agent (global tool setting)'),
}

const agentSpec = InputSpec.of({
  id: Value.text({
    name: i18n('ID'),
    description: i18n(
      'Short permanent name used to spawn it (e.g. "researcher"). Lowercase letters, digits and "-". Changing the ID makes a new agent.',
    ),
    required: true,
    default: null,
    placeholder: 'researcher',
    patterns: [
      {
        regex: '^[a-z][a-z0-9-]{0,31}$',
        description: i18n(
          'Lowercase letters, digits and "-", starting with a letter (max 32).',
        ),
      },
    ],
  }),
  name: Value.text({
    name: i18n('Display Name'),
    description: i18n('Optional, e.g. "Researcher".'),
    required: false,
    default: null,
    placeholder: 'Researcher',
  }),
  model: Value.dynamicSelect(async () => {
    const cfg = await liveConfig()
    const current = Object.values(entriesOf(cfg))
      .map(modelRef)
      .filter((r) => r !== 'default')
    const main = cfg?.agents?.defaults?.model?.primary
    const values = {
      default: i18n("Main agent's model") + (main ? ` (${main})` : ''),
      ...(await agentModelChoices(
        {
          anthropic: ANTHROPIC_MODELS,
          openai: OPENAI_MODELS,
          google: GEMINI_MODELS,
          xai: GROK_MODELS,
        },
        cfg?.models?.providers?.[OLLAMA_SERVER_ID]?.baseUrl,
        current,
      )),
    }
    return {
      name: i18n('Model'),
      description: i18n(
        'Cloud models of the providers with a saved API key, and (if turned on in Configure AI Provider → Local Chat Models) the tool-capable models on your own Ollama server, listed live.',
      ),
      default: 'default',
      values,
    }
  }),
  profile: Value.select({
    name: i18n('Tool Profile'),
    description: i18n(
      'The base set of tools. Spawned agents never get gateway, cron, message or a few other system tools, whatever is chosen here.',
    ),
    default: 'minimal',
    values: PROFILES,
  }),
  extraTools: Value.text({
    name: i18n('Extra Tools'),
    description: i18n(
      'Comma-separated tools added to the profile, e.g. read, web_search, web_fetch, memory_search, view_image, browser, write, edit, exec; or groups such as group:web, group:memory, group:fs.',
    ),
    required: false,
    default: null,
    placeholder: 'read, web_search',
  }),
  blockedTools: Value.text({
    name: i18n('Blocked Tools'),
    description: i18n(
      'Comma-separated tools that are always off for this agent.',
    ),
    required: false,
    default: null,
    placeholder: 'gateway, cron',
  }),
  skills: Value.text({
    name: i18n('Skills'),
    description: i18n(
      '"all" (every skill the main agent has), "none", or a comma-separated list of skill names, e.g. health, qdrant, ntfy.',
    ),
    required: true,
    default: 'none',
    placeholder: 'none',
  }),
  canSpawn: Value.text({
    name: i18n('Can Spawn'),
    description: i18n(
      'Comma-separated IDs of other agents this one may start, e.g. "researcher, writer". "*" means any agent. Leave empty for none.',
    ),
    required: false,
    default: null,
    placeholder: 'researcher, writer',
  }),
  mainCanSpawn: Value.toggle({
    name: i18n('Main Agent Can Spawn'),
    description: i18n('Whether the main agent may start this agent.'),
    default: true,
  }),
  workspace: Value.text({
    name: i18n('Instructions Folder'),
    description: i18n(
      "Folder holding this agent's AGENTS.md (the only instructions a spawned agent sees). Leave empty for workspace/workspaces/<ID>. A starter AGENTS.md is created there if missing. Must be inside /data/.openclaw/workspace.",
    ),
    required: false,
    default: null,
    placeholder: '/data/.openclaw/workspace/workspaces/<ID>',
  }),
})

const inputSpec = InputSpec.of({
  agents: Value.list(
    sdk.List.obj(
      {
        name: i18n('Agents'),
        description: i18n(
          "Helper agents the main agent (or another agent) can spawn for focused work. The main agent can also create and change them in conversation (agents skill); they appear here.\n\nEach agent's personality and instructions live in AGENTS.md in its folder; this form sets what it is allowed to do and which model it runs on. Deleting an agent keeps its folder.",
        ),
        default: [],
      },
      {
        spec: agentSpec,
        displayAs: '{{id}}',
        uniqueBy: 'id',
      },
    ),
  ),
})

// ── Turning edits into helper operations ────────────────────────────────────

const list = (s: string | null | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** Helper fields for one row (the helper's own field names). */
function fieldsOf(r: Row) {
  const skills = (r.skills ?? '').trim().toLowerCase()
  return {
    name: (r.name ?? '').trim(),
    model: r.model || 'default',
    profile: r.profile || 'inherit',
    extraTools: list(r.extraTools),
    blockedTools: list(r.blockedTools),
    skills: skills === 'all' || skills === 'none' ? skills : list(r.skills),
    canSpawn: list(r.canSpawn),
    mainCanSpawn: !!r.mainCanSpawn,
    workspace: (r.workspace ?? '').trim(),
  }
}

type Op = { op: 'create' | 'update' | 'delete'; id: string; fields?: object }

export function diff(base: Row[], next: Row[]): Op[] {
  const before = new Map(base.map((r) => [r.id, fieldsOf(r)]))
  const ops: Op[] = []
  for (const r of next) {
    const now = fieldsOf(r)
    const was = before.get(r.id)
    if (!was) {
      ops.push({ op: 'create', id: r.id, fields: now })
      continue
    }
    const changed: Record<string, unknown> = {}
    for (const k of Object.keys(now) as (keyof typeof now)[]) {
      if (JSON.stringify(now[k]) !== JSON.stringify(was[k])) changed[k] = now[k]
    }
    if (Object.keys(changed).length) {
      ops.push({ op: 'update', id: r.id, fields: changed })
    }
  }
  const kept = new Set(next.map((r) => r.id))
  for (const id of before.keys()) {
    if (!kept.has(id)) ops.push({ op: 'delete', id })
  }
  return ops
}

async function readSnapshot(): Promise<Row[] | null> {
  try {
    return JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Row[]
  } catch {
    return null
  }
}

// ── Action ──────────────────────────────────────────────────────────────────

export const configureAgents = sdk.Action.withInput(
  'configure-agents',

  async () => ({
    name: i18n('Configure Agents'),
    description: i18n(
      'Add, change or remove the helper agents the main agent can spawn: their model (cloud or your own Ollama server), tools, skills and who may start them.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const rows = rowsFrom(await liveConfig())
    await writeFile(SNAPSHOT, JSON.stringify(rows)).catch(() => {})
    // Model values are validated against the dynamic list at submit.
    return { agents: rows as any }
  },

  async ({ effects, input }) => {
    const next = (input.agents ?? []) as Row[]
    const base = (await readSnapshot()) ?? rowsFrom(await liveConfig())
    const ops = diff(base, next)
    if (!ops.length) {
      return {
        version: '1' as const,
        title: i18n('No changes'),
        message: i18n('Nothing was changed.'),
        result: null,
      }
    }

    const res = await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'openclaw' },
      mainMounts(),
      'configure-agents',
      (subc) =>
        subc.exec(['python3', HELPER, 'apply', '--ui'], {
          user: 'node',
          env: OPENCLAW_CLI_ENV,
          input: JSON.stringify({ ops }),
          timeout: 300_000,
        }),
    )
    let out: any
    try {
      out = JSON.parse(String(res.stdout).trim().split('\n').pop() || '{}')
    } catch {
      out = { ok: false, error: String(res.stderr || res.stdout).trim() }
    }
    if (!out.ok) {
      throw new Error(
        `${i18n('Not saved:')} ${out.error || i18n('the agents helper failed')}`,
      )
    }
    // The next opening of the form starts from the new state.
    await writeFile(
      SNAPSHOT,
      JSON.stringify(rowsFrom(await liveConfig())),
    ).catch(() => {})

    const created: string[] = out.createdFiles ?? []
    return {
      version: '1' as const,
      title: i18n('Agents saved'),
      message:
        (out.notes ?? []).join('\n') +
        (created.length
          ? `\n\n${i18n('Starter instructions were created in:')}\n${created.join('\n')}\n${i18n('Ask the main agent to fill them in with you, or edit them in the workspace.')}`
          : '') +
        '\n\n' +
        i18n('Changes apply without a restart.'),
      result: null,
    }
  },
)
