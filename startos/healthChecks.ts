import type { SubContainer } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { RBW_ENV } from './vault'

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
 * file pinentry and the Vaultwarden connection; `rbw unlocked` confirms it.
 * Unlock is a no-op when already unlocked.
 */
export async function probeVault(sub: Sub): Promise<Result> {
  try {
    const res = await sub.exec(
      ['sh', '-c', 'timeout 60 rbw unlock && rbw unlocked'],
      { user: 'node', env: RBW_ENV, timeout: 90_000 },
    )
    if (res.exitCode === 0) {
      return { result: 'success', message: 'Vault unlocked' }
    }
    const why =
      res.exitCode === 124
        ? 'unlock timed out'
        : firstLine(res.stderr) || `exit ${res.exitCode}`
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
} as const

type HttpKey = keyof typeof HTTP_PATHS

/** Enabled external-service targets, in display order. */
export function externalTargets(ext: ExtConfig): HealthTarget[] {
  const out: HealthTarget[] = []
  const push = (key: HttpKey) => {
    const svc = ext?.[key]
    if (!svc?.enabled || !svc.url) return
    const [label, path] = HTTP_PATHS[key]
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
  return { display: t.label, fn: probeVault }
}

export function externalChecks(ext: ExtConfig) {
  const byKey = new Map(externalTargets(ext).map((t) => [t.key, t]))
  return {
    vaultwarden: specFor(byKey.get('vaultwarden')),
    ollama: specFor(byKey.get('ollama')),
    n8n: specFor(byKey.get('n8n')),
    trilium: specFor(byKey.get('trilium')),
    searxng: specFor(byKey.get('searxng')),
    crawl4ai: specFor(byKey.get('crawl4ai')),
    ntfy: specFor(byKey.get('ntfy')),
    nas: specFor(byKey.get('nas')),
  } satisfies Record<string, CheckSpec>
}
