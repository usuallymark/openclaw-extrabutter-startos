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
//   does not depend on DNS, the StartOS certificate or the LAN address, and
//   the clone URLs Gitea itself shows work as they are.

export const GIT_SYSTEM_CONFIG = '/etc/gitconfig'
export const GIT_CREDENTIAL_HELPER = '/usr/local/bin/git-credential-openclaw'

const trimSlash = (u: string) => u.replace(/\/+$/, '')

/**
 * Watchable: every address Gitea "On this server" publishes for its web/git
 * interface (LAN IPs, .local, private and public domains), without the
 * bridge. [] while Gitea is not installed. main re-runs when the list
 * changes (a domain added in Gitea's Interfaces page, a new LAN port).
 */
export function giteaPublishedUrls(effects: T.Effects): Promise<string[]> {
  const s = LOCAL_SERVICES.gitea
  return sdk.host
    .get(effects, { hostId: s.hostId, packageId: s.packageId }, (host) => {
      // Gitea's web/git interface (id "http", gitea-startos utils.ts).
      const iface = Object.values(host?.bindings ?? {})
        .flatMap((b) => Object.values(b.interfaces))
        .find((i) => i.id === 'http')
      const urls = iface
        ? (iface.addressInfo.nonLocal.format('urlstring') as string[])
        : []
      return Array.from(new Set(urls.map(trimSlash))).sort()
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
    if (aliases.length) {
      lines.push(`[url ${q(base + '/')}]`)
      for (const a of aliases) lines.push(`\tinsteadOf = ${a}/`)
    }
  }
  return lines.join('\n') + '\n'
}
