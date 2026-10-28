import type { SubContainer, T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { RBW_ENV, VAULT_PROBE_SCRIPT } from './vault'
import { EmailConfig, googleSignInStatus, usesMailService } from './email'
import { MAIL_URL } from './mailService'
import {
  MAIL_QUEUE_TASK,
  reviewOutgoingMail,
} from './actions/reviewOutgoingMail'
import { LocalKey, notInstalledMessage } from './localServices'

// Health checks for the vault and external services.
//
// Every probe runs INSIDE the openclaw subcontainer, so it sees exactly what
// the agent sees: the /etc/hosts mappings and custom CA certs installed by
// the network-setup oneshot. Probing from the package runtime instead would
// fail on .local names and internal certificates the agent handles fine.
//
// Checks are reachability-only: no credentials are sent to external services.
// A disabled service keeps its slot in the chain but is hidden (display null)
// and reports 'disabled', which keeps the daemon chain static and typed.

type Sub = SubContainer<typeof sdk.manifest>
type Result =
  | { result: 'success'; message: string | null }
  | { result: 'failure'; message: string }
  | { result: 'disabled'; message: string | null }

const DISABLED: Result = { result: 'disabled', message: null }

// statusTrigger waits one interval *before* each check, and the first wait
// uses the `starting` interval (or the default when none is given). Without
// `starting`, the vault check showed nothing for 5 minutes after every
// restart even though the vault was already unlocked.
//
// External services: first check after 3 s, then 60 s while healthy, 30 s
// while failing.
export const externalTrigger = sdk.trigger.statusTrigger(60_000, {
  starting: 3_000,
  failure: 30_000,
})
// Vault: first check after 3 s, then an unlock round-trip every 5 minutes
// (1 minute while failing).
export const vaultTrigger = sdk.trigger.statusTrigger(300_000, {
  starting: 3_000,
  failure: 60_000,
})

const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + path

function firstLine(s: unknown): string {
  return (
    String(s ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l) ?? ''
  )
}

/**
 * HTTP reachability from inside the container. Any HTTP response below 500
 * counts as reachable (401/403 just mean "up, wants credentials"); `okBelow`
 * tightens that (e.g. 300 for our own /healthz endpoints).
 */
export async function probeHttp(
  sub: Sub,
  label: string,
  url: string,
  opts: { okBelow?: number } = {},
): Promise<Result> {
  const okBelow = opts.okBelow ?? 500
  try {
    const res = await sub.exec(
      [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--max-time',
        '8',
        url,
      ],
      { user: 'node', timeout: 15_000 },
    )
    const code = parseInt(String(res.stdout).trim(), 10)
    if (res.exitCode === 0 && code > 0 && code < okBelow) {
      return { result: 'success', message: `${label} reachable` }
    }
    if (res.exitCode === 0) {
      return {
        result: 'failure',
        message: `${label} returned HTTP ${code} at ${url}`,
      }
    }
    return {
      result: 'failure',
      message: `${label} unreachable at ${url}: ${firstLine(res.stderr) || `curl exit ${res.exitCode}`}`,
    }
  } catch (e) {
    return {
      result: 'failure',
      message: `${label} check error: ${firstLine((e as Error)?.message)}`,
    }
  }
}

/** Plain TCP connect (used for SMB on the NAS). */
export async function probeTcp(
  sub: Sub,
  label: string,
  host: string,
  port: number,
): Promise<Result> {
  try {
    const res = await sub.exec(
      ['bash', '-c', 'timeout 5 bash -c "</dev/tcp/$H/$P" 2>&1'],
      { user: 'node', env: { H: host, P: String(port) }, timeout: 15_000 },
    )
    if (res.exitCode === 0) {
      return { result: 'success', message: `${label} reachable` }
    }
    return {
      result: 'failure',
      message: `${label} unreachable at ${host}:${port}${res.exitCode === 124 ? ' (timed out)' : `: ${firstLine(res.stdout) || `exit ${res.exitCode}`}`}`,
    }
  } catch (e) {
    return {
      result: 'failure',
      message: `${label} check error: ${firstLine((e as Error)?.message)}`,
    }
  }
}

/**
 * End-to-end vault check: `rbw unlock` exercises the master password, the
 * file pinentry and the Vaultwarden connection (a no-op when unlocked), and
 * `rbw sync` confirms Vaultwarden still accepts rbw's sign-in. rbw keeps
 * answering from its local copy when a sync fails, so without the sync a
 * refused sign-in looked healthy while vault edits stopped arriving.
 */
export async function probeVault(sub: Sub): Promise<Result> {
  try {
    const res = await sub.exec(['sh', '-c', VAULT_PROBE_SCRIPT], {
      user: 'node',
      env: RBW_ENV,
      timeout: 150_000,
    })
    if (res.exitCode === 0) {
      return { result: 'success', message: 'Vault unlocked and synced' }
    }
    const why = firstLine(res.stderr) || `exit ${res.exitCode}`
    if (res.exitCode === 20) {
      return {
        result: 'failure',
        message: `Vault unlocked, but syncing with Vaultwarden fails (${why}): changes made in Vaultwarden do not reach OpenClaw. If Vaultwarden is running, restart OpenClaw to sign in again.`,
      }
    }
    return {
      result: 'failure',
      message: `Vault locked — ${why}. Check the master password and Vaultwarden settings in Configure External Services.`,
    }
  } catch (e) {
    return {
      result: 'failure',
      message: `Vault check error: ${firstLine((e as Error)?.message)}`,
    }
  }
}

// ── Per-service specs, built from the external-services config ─────────────

export type ExtConfig =
  | {
      vaultwarden?: { enabled?: boolean; url?: string }
      ollama?: { enabled?: boolean; url?: string }
      nas?: { enabled?: boolean; host?: string }
      n8n?: { enabled?: boolean; url?: string }
      trilium?: { enabled?: boolean; url?: string }
      searxng?: { enabled?: boolean; url?: string }
      crawl4ai?: { enabled?: boolean; url?: string }
      ntfy?: { enabled?: boolean; url?: string }
      gitea?: { enabled?: boolean; url?: string }
    }
  | undefined
  | null

export type CheckSpec = {
  display: string | null
  fn: (sub: Sub) => Promise<Result>
}

/**
 * One enabled check, as plain data. The StartOS health checks below and the
 * in-container probe (/opt/skills/health/health.py, via the
 * OPENCLAW_HEALTH_TARGETS env var) are both built from these, so the agent's
 * report and the UI cannot drift apart.
 */
export type HealthTarget =
  | { key: string; label: string; kind: 'http'; url: string; okBelow?: number }
  | { key: string; label: string; kind: 'tcp'; host: string; port: number }
  | { key: string; label: string; kind: 'vault' }
  | { key: string; label: string; kind: 'google'; address: string }
  | { key: string; label: string; kind: 'mail'; url: string }
  | { key: string; label: string; kind: 'missing'; message: string }

// Health path per HTTP service, appended to the configured URL.
const HTTP_PATHS = {
  vaultwarden: ['Vaultwarden', '/alive'],
  ollama: ['Ollama', '/api/tags'],
  n8n: ['n8n', '/healthz'],
  // Trilium's URL already ends in /etapi; app-info answers 401 without a
  // token, which still proves the ETAPI is up.
  trilium: ['Trilium', '/app-info'],
  searxng: ['SearXNG', '/healthz'],
  // /health needs no token and answers {"status":"ok",...}.
  crawl4ai: ['Crawl4AI', '/health'],
  // ntfy's /v1/health needs no token and answers {"healthy":true}.
  ntfy: ['ntfy', '/v1/health'],
  // Gitea's /api/healthz needs no token and answers {"status":"pass",...}.
  gitea: ['Gitea', '/api/healthz'],
} as const

type HttpKey = keyof typeof HTTP_PATHS

/**
 * Enabled external-service targets, in display order. `ext` has "On this
 * server" URLs already resolved (localServices.ts); `missing` lists the
 * services chosen as local whose package is not installed.
 */
export function externalTargets(
  ext: ExtConfig,
  missing: Partial<Record<LocalKey, string>> = {},
  email?: EmailConfig,
): HealthTarget[] {
  const out: HealthTarget[] = []
  const push = (key: HttpKey) => {
    const svc = ext?.[key]
    const [label, path] = HTTP_PATHS[key]
    const absent = (missing as Record<string, string | undefined>)[key]
    if (svc?.enabled && absent) {
      out.push({
        key,
        label,
        kind: 'missing',
        message: notInstalledMessage(absent),
      })
      return
    }
    if (!svc?.enabled || !svc.url) return
    out.push({ key, label, kind: 'http', url: joinUrl(svc.url, path) })
  }
  push('vaultwarden')
  push('ollama')
  const nas = ext?.nas
  if (nas?.enabled && nas.host) {
    out.push({
      key: 'nas',
      label: 'NAS (SMB)',
      kind: 'tcp',
      host: nas.host,
      port: 445,
    })
  }
  push('n8n')
  push('trilium')
  push('searxng')
  push('crawl4ai')
  push('ntfy')
  push('gitea')
  // Email (Configure Email): the mail service's own state for the Gmail
  // and IMAP choices (in StartOS it is the "Mail Service" daemon line);
  // the stored sign-in for the Google account.
  if (usesMailService(email)) {
    out.push({
      key: 'email',
      label: 'Mail Service',
      kind: 'mail',
      url: `${MAIL_URL}/healthz`,
    })
  } else if (email?.mode === 'google' && email.address) {
    out.push({
      key: 'email',
      label: 'Google account',
      kind: 'google',
      address: email.address,
    })
  }
  return out
}

function specFor(t: HealthTarget | undefined): CheckSpec {
  if (!t) return { display: null, fn: async () => DISABLED }
  if (t.kind === 'http') {
    return { display: t.label, fn: (sub) => probeHttp(sub, t.label, t.url) }
  }
  if (t.kind === 'tcp') {
    // The UI keeps calling the NAS "NAS" in messages.
    return {
      display: t.label,
      fn: (sub) =>
        probeTcp(sub, t.key === 'nas' ? 'NAS' : t.label, t.host, t.port),
    }
  }
  if (t.kind === 'google') {
    return { display: t.label, fn: (sub) => probeGoogle(sub, t.address) }
  }
  if (t.kind === 'mail') {
    // Shown by the mail daemon's own readiness line instead.
    return { display: null, fn: async () => DISABLED }
  }
  if (t.kind === 'missing') {
    const message = t.message
    return {
      display: t.label,
      fn: async () => ({ result: 'failure' as const, message }),
    }
  }
  return { display: t.label, fn: probeVault }
}

/** Google account: is a sign-in stored and readable? Local; no network. */
async function probeGoogle(sub: Sub, address: string): Promise<Result> {
  try {
    const s = await googleSignInStatus(sub, address)
    return s.ok
      ? { result: 'success', message: s.message }
      : { result: 'failure', message: s.message }
  } catch (e) {
    return {
      result: 'failure',
      message: `Google sign-in check error: ${firstLine((e as Error)?.message)}`,
    }
  }
}

export function externalChecks(
  ext: ExtConfig,
  missing: Partial<Record<LocalKey, string>> = {},
  email?: EmailConfig,
) {
  const byKey = new Map(
    externalTargets(ext, missing, email).map((t) => [t.key, t]),
  )
  return {
    vaultwarden: specFor(byKey.get('vaultwarden')),
    ollama: specFor(byKey.get('ollama')),
    n8n: specFor(byKey.get('n8n')),
    trilium: specFor(byKey.get('trilium')),
    searxng: specFor(byKey.get('searxng')),
    crawl4ai: specFor(byKey.get('crawl4ai')),
    ntfy: specFor(byKey.get('ntfy')),
    gitea: specFor(byKey.get('gitea')),
    nas: specFor(byKey.get('nas')),
    email: specFor(byKey.get('email')),
  } satisfies Record<string, CheckSpec>
}

// ── Mail service ────────────────────────────────────────────────────────────

// The `since` of the last refused-password state already announced, so a
// refusal is announced once (StartOS notification + ntfy), not every check.
let announcedRefusal: string | null = null

async function mailHealthz(sub: Sub): Promise<any | null> {
  try {
    const res = await sub.exec(
      ['curl', '-sS', '--max-time', '5', `${MAIL_URL}/healthz`],
      { user: 'node', timeout: 15_000 },
    )
    if (res.exitCode !== 0) return null
    return JSON.parse(String(res.stdout))
  } catch {
    return null
  }
}

/**
 * The mail daemon's readiness: the service answers (in any state). Its
 * state is the separate "Mail Service" check (probeMail), so a refused
 * password shows at once instead of "starting" for the grace period.
 */
export async function mailAnswers(
  sub: Sub,
): Promise<Result | { result: 'starting'; message: string }> {
  return (await mailHealthz(sub))
    ? { result: 'success', message: 'Mail service answering' }
    : { result: 'starting', message: 'Mail service starting' }
}

function sendingText(h: any): string {
  const q = Array.isArray(h.queue) ? h.queue.length : 0
  const waiting = q
    ? `; ${q} message${q > 1 ? 's' : ''} waiting for your approval (Review Outgoing Mail)`
    : ''
  switch (h.sending) {
    case 'off':
      return 'read only, no drafts'
    case 'rules':
      return (
        (h.others === 'auto'
          ? 'sending by rules. Warning: Anyone Else is set to Send automatically, so mail can go to any address without asking you'
          : h.others === 'block'
            ? 'sending by rules (only to your automatic list)'
            : 'sending by rules (others wait for your approval)') + waiting
      )
    default:
      return 'drafts only, nothing is sent' + waiting
  }
}

// Queue items already announced (StartOS notification + ntfy), and the
// last queue the StartOS task was set for.
const announcedQueue = new Set<string>()
let taskFor: string | null = null

async function syncQueueTask(
  effects: T.Effects,
  sub: Sub,
  h: any,
  live: () => boolean,
) {
  const queue = (Array.isArray(h.queue) ? h.queue : []) as {
    id: string
    to?: string
    subject?: string
    rule?: string
  }[]
  const key = queue.map((q) => q.id).join(',')
  if (key !== taskFor) {
    if (queue.length) {
      await within(
        20_000,
        sdk.action.createOwnTask(effects, reviewOutgoingMail, 'important', {
          reason: `${queue.length} outgoing message${queue.length > 1 ? 's' : ''} waiting for your approval`,
          replayId: MAIL_QUEUE_TASK,
        }),
        'approval task',
      )
    } else {
      await within(
        20_000,
        sdk.action.clearTask(effects, MAIL_QUEUE_TASK),
        'clear approval task',
      )
    }
    taskFor = key
  }
  for (const q of queue) {
    if (!live()) return
    if (announcedQueue.has(q.id)) continue
    announcedQueue.add(q.id)
    const text = `Mail waiting for approval: to ${q.to || '?'}, "${q.subject || ''}" (${q.rule || 'rules'}). Open Actions → Review Outgoing Mail.`
    await within(
      20_000,
      sdk.notification.create(effects, {
        level: 'info',
        title: 'Outgoing mail needs approval',
        message: text,
      }),
      'notification',
    ).catch(() => {})
    await sub
      .exec(['notify', '--title', 'OpenClaw mail', '--tags', 'email', text], {
        user: 'node',
        env: { HOME: '/data' },
        timeout: 30_000,
      })
      .catch(() => {})
  }
}

// ── Side jobs, never awaited by the check ──────────────────────────────────
//
// StartOS stops a service only after every health check finishes the run it
// is in (HealthDaemon.stopSession awaits it). 2026.10.1:10 did the approval
// task, the alerts and the idle-conversation reset inside the Mail Service
// check; a restart that began during one of those runs waited on it for
// good (a task created from the context being torn down never answers), and
// a reboot queued behind it. Now the check only reads /healthz and returns;
// the rest runs here, one job at a time, every step with a time limit, and
// nothing starts once the context is being left.

const left = new WeakSet<T.Effects>()
const watched = new WeakSet<T.Effects>()
let sideJob: Promise<void> | null = null

function within<R>(ms: number, p: Promise<R>, what: string): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<R>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}: no answer in ${ms / 1000} s`)),
      ms,
    )
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

function mailSideJobs(effects: T.Effects, sub: Sub, h: any) {
  if (!watched.has(effects)) {
    watched.add(effects)
    effects.onLeaveContext(() => {
      left.add(effects)
    })
  }
  if (sideJob || left.has(effects)) return
  sideJob = (async () => {
    const live = () => !left.has(effects)
    try {
      if (live()) await syncQueueTask(effects, sub, h, live)
    } catch (e) {
      console.warn(`mail queue task: ${(e as Error)?.message}`)
    }
    try {
      if (live() && h.state === 'refused' && announcedRefusal !== h.since) {
        announcedRefusal = h.since
        await announceRefusal(effects, sub, String(h.reason ?? ''))
      }
    } catch (e) {
      console.warn(`mail refusal notice: ${(e as Error)?.message}`)
    }
    try {
      if (live() && h.state === 'ok') {
        await within(150_000, resetIdleEmailSession(sub), 'email session reset')
      }
    } catch (e) {
      console.warn(`email session reset: ${(e as Error)?.message}`)
    }
  })().finally(() => {
    sideJob = null
  })
}

/**
 * The "Mail Service" line: the service's own /healthz (state, reason,
 * sending level, approval queue). Returns as soon as that is read; the
 * task, alerts and session reset run as side jobs (above).
 */
export async function probeMail(
  effects: T.Effects,
  sub: Sub,
): Promise<Result | { result: 'starting'; message: string }> {
  const h = await mailHealthz(sub)
  if (!h) return { result: 'starting', message: 'Mail service starting' }
  const addr = h.address ? ` (${h.address})` : ''
  mailSideJobs(effects, sub, h)
  switch (h.state) {
    case 'ok':
      announcedRefusal = null
      return {
        result: 'success',
        message: `Signed in${addr}; ${sendingText(h)}`,
      }
    case 'starting':
    case 'reloading':
      return {
        result: 'starting',
        message: `Mail service ${h.state}${h.reason ? `: ${h.reason}` : ''}`,
      }
    case 'refused':
      return { result: 'failure', message: `Mail${addr}: ${h.reason}` }
    default:
      return {
        result: 'failure',
        message: `Mail${addr}: ${h.reason || h.state}${h.note ? ` (${h.note})` : ''}`,
      }
  }
}

async function announceRefusal(effects: T.Effects, sub: Sub, reason: string) {
  await within(
    20_000,
    sdk.notification.create(effects, {
      level: 'warning',
      title: 'Mailbox refused the password',
      message: `${reason}. The mail service will not try that password again; it checks for a new one every 10 minutes.`,
    }),
    'notification',
  )
  // ntfy, when configured (notify reads its settings from the gateway).
  await sub.exec(
    ['notify', '--title', 'OpenClaw mail', '--tags', 'warning', reason],
    { user: 'node', env: { HOME: '/data' }, timeout: 30_000 },
  )
}

// ── Email agent conversation ────────────────────────────────────────────────

// The email agent works in one conversation (agent:email:main), reached by
// the main agent with sessions_send. The main agent cannot reset it when the
// request comes from webchat or a channel (OpenClaw gives non-owners only
// `assign_owner` in the sessions tool), so the package clears it here: after
// 15 minutes without a request, so follow-ups in one chat keep their
// context but old mail does not pile up. Checked at most every 5 minutes.
const EMAIL_SESSION = 'agent:email:main'
const IDLE_MS = 15 * 60_000
let lastSessionCheck = 0

const CLI_ENV = { HOME: '/data', OPENCLAW_STATE_DIR: '/data/.openclaw' }

async function gatewayCall(sub: Sub, method: string, params: object) {
  const r = await sub.exec(
    [
      'openclaw',
      'gateway',
      'call',
      method,
      '--json',
      '--params',
      JSON.stringify(params),
    ],
    { user: 'node', env: CLI_ENV, timeout: 60_000 },
  )
  if (r.exitCode !== 0) return null
  const out = String(r.stdout)
  const i = out.indexOf('{')
  return i < 0 ? null : JSON.parse(out.slice(i))
}

export async function resetIdleEmailSession(sub: Sub, now = Date.now()) {
  if (now - lastSessionCheck < 5 * 60_000) return
  lastSessionCheck = now
  const list = await gatewayCall(sub, 'sessions.list', {
    agentId: 'email',
    limit: 20,
  })
  const s = (list?.sessions ?? []).find((x: any) => x?.key === EMAIL_SESSION)
  if (!s || s.hasActiveRun || !(Number(s.totalTokens) > 0)) return
  const last = Number(s.lastInteractionAt ?? s.updatedAt ?? 0)
  if (!last || now - last < IDLE_MS) return
  const res = await gatewayCall(sub, 'sessions.reset', { key: EMAIL_SESSION })
  if (res?.ok) {
    console.info('Email agent: conversation cleared after 15 minutes idle')
  }
}
