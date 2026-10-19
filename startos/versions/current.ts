import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:5',
  releaseNotes: {
    en_US: `Gitea.

- **Gitea joins Configure External Services**, with Disabled, On this server and At an address like the others. The agent can then keep its workspace, scripts and projects in your own git repositories: create a repository, commit and push, with nothing going to a public site. Enter an access token of the Gitea account the agent uses (permissions: repository and user, Read and Write), or fetch it from Vaultwarden (item gitea, field api_key).
- **git signs in to Gitea by itself.** Every push and pull uses the token, fetched at that moment; nothing is written into repositories, remote URLs or credential files.
- **Existing remotes keep working.** With Gitea on this server, remotes written with any address Gitea shows (its clone URL, a LAN address, a private domain) go over the server's internal network, so they no longer depend on that address, DNS or the certificate.
- **A new gitea skill** gives the agent one documented way to create repositories, add remotes and push, and \`gitea.py check\` reports the set-up, including tokens stored in plain text. The health checks show whether Gitea answers and which account the token belongs to.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
