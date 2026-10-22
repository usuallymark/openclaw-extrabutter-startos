import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_6 = VersionInfo.of({
  version: '2026.10.1:6',
  releaseNotes: {
    en_US: `Gitea remotes that never go stale.

- **New Gitea remotes use a placeholder: gitea:OWNER/REPO.git.** At every start the package maps gitea: to Gitea's current address, the way the other services get their address from a setting. Remotes made by the agent keep working after Gitea is reinstalled, gets a new LAN address or domain, or moves to another address. (In 2026.10.1:5, new repositories got the internal address Gitea reports to OpenClaw, which changes when Gitea is reinstalled.)
- **Links the agent gives you** use an address you can open: a domain if Gitea has one, otherwise its LAN address.
- **\`gitea.py check\` finds remotes made with the internal address**, and \`check --fix\` changes them to gitea:. Remotes written with Gitea's own addresses keep working as before.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
