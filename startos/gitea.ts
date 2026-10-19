import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { LOCAL_SERVICES } from './localServices'

// Gitea (Configure External Services → Gitea): git itself signs in with the
// configured token, and remotes written with any of Gitea's own addresses keep
// working when Gitea is "On this server".
//
// The settings go into git's *system* config (/etc/gitconfig in the
// container), rewritten at every start, so the user's and the agent's own
// ~/.gitconfig is never touched, and every git run in the container (the
// agent, a git hook, a root attach shell) gets the same behaviour:
//
// - credential.<Gitea URL>.helper: the helper below, which asks getcred for
//   GITEA_KEY at every push/pull. The token is never stored by git.
// - url.<bridge URL>.insteadOf <each address Gitea publishes>: a remote
//   written as https://<LAN IP>:<port>/…, https://<private domain>/… or
//   http://<name>.local/… is fetched over the internal bridge instead, so it
//   does not depend on DNS, the StartOS certificate or the LAN address.
// - url.<Gitea URL>.insteadOf gitea: — the placeholder new remotes are
//   written with (gitea:OWNER/REPO.git), like a variable: it always means
//   Gitea's current address, so those remotes never go stale (a reinstall,
//   a new LAN IP or domain, Gitea moved to another address).

export const GIT_SYSTEM_CONFIG = '/etc/gitconfig'
export const GIT_CREDENTIAL_HELPER = '/usr/local/bin/git-credential-openclaw'
export const GIT_REMOTE_PREFIX = 'gitea:'

const trimSlash = (u: string) => u.replace(/\/+$/, '')

// Which published address links shown to people use (GITEA_WEB_URL), best
// first: a domain, then the LAN IP, then .local; https before http. Never
// the bridge: it changes when Gitea is reinstalled and works only inside
// this server.
const KIND_RANK: Record<string, number> = {
  'public-domain': 0,
  'private-domain': 1,
  ipv4: 2,
  mdns: 3,
  ipv6: 4,
  plugin: 5,
}

export type GiteaAddresses = {
  /** Every published address, mapped onto the bridge for git. */
  aliases: string[]
  /** The address for links shown to people (GITEA_WEB_URL), or null. */
  web: string | null
}

/**
 * Watchable: the addresses Gitea "On this server" publishes for its web/git
 * interface (LAN IPs, .local, private and public domains, Tor), without the
 * bridge. Empty while Gitea is not installed. main re-runs when they change
 * (a domain added in Gitea's Interfaces page, a new LAN port).
 *
 * Gitea itself can't supply a stable address: by default
 * (PUBLIC_URL_DETECTION = auto) it builds clone URLs from the address a
 * request arrived at, which for OpenClaw is the bridge.
 */
export function giteaAddresses(effects: T.Effects): Promise<GiteaAddresses> {
  const s = LOCAL_SERVICES.gitea
  return sdk.host
    .get(effects, { hostId: s.hostId, packageId: s.packageId }, (host) => {
      // Gitea's web/git interface (id "http", gitea-startos utils.ts).
      const iface = Object.values(host?.bindings ?? {})
        .flatMap((b) => Object.values(b.interfaces))
        .find((i) => i.id === 'http')
      if (!iface) return { aliases: [], web: null }
      const info = iface.addressInfo.nonLocal
      const ranked = info.hostnames
        .map((h) => ({
          url: trimSlash(info.toUrl(h)),
          rank: (h.ssl ? 0 : 10) + (KIND_RANK[h.metadata.kind] ?? 9),
        }))
        .sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url))
      return {
        aliases: Array.from(new Set(ranked.map((r) => r.url))).sort(),
        web: ranked[0]?.url ?? null,
      }
    })
    .const()
}

/** git value quoting: wrap in double quotes, escaping \ and ". */
const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The system git config for the Gitea settings: `url` is the URL OpenClaw
 * uses (bridge or configured address); `aliases` the addresses rewritten to
 * it. With no Gitea, a header only, which also clears an earlier mapping.
 */
export function giteaGitConfig(
  gitea: { url: string; aliases: string[] } | null,
): string {
  const lines = [
    '# Written by OpenClaw Extra Butter at every start, from Configure External',
    '# Services → Gitea. Changes here are replaced; personal git settings belong',
    '# in ~/.gitconfig (/data/.gitconfig for the agent).',
  ]
  if (gitea) {
    const base = trimSlash(gitea.url)
    lines.push(`[credential ${q(base)}]`, `\thelper = ${GIT_CREDENTIAL_HELPER}`)
    const aliases = gitea.aliases.map(trimSlash).filter((a) => a !== base)
    lines.push(
      `[url ${q(base + '/')}]`,
      `\tinsteadOf = ${GIT_REMOTE_PREFIX}`,
      ...aliases.map((a) => `\tinsteadOf = ${a}/`),
    )
  }
  return lines.join('\n') + '\n'
}
