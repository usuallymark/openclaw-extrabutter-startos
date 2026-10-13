import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_0 = VersionInfo.of({
  version: '2026.10.1:0',
  releaseNotes: {
    en_US: `OpenClaw 2026.10.1. **Make a StartOS backup before updating**: the first start migrates the agent databases (1–2 minutes), which cannot be undone.

- **OpenClaw 2026.10.1** (from 2026.9.9). Among upstream's fixes: a gateway now keeps its state ownership when OpenClaw's command-line tool runs from a separate container, the failure that 2026.9.9:1 worked around. Actions still run the tool inside the gateway's own container.
- **The SimpleX plugin is upgraded to 2.2.0 automatically** on the first start, before the gateway. OpenClaw 2026.10.1 cannot load plugin 2.1 or older, and with it installed, OpenClaw's own repair step and agent changes (Configure Agents) fail. If the upgrade cannot download the plugin, it is retried at the next start and Configure SimpleX asks to be submitted again.
- The webchat uses OpenClaw 2026.10.1's gateway client.
- The README and the setup guide now describe the bundled rbw client as part of the package, with Vaultwarden as the service you point it at.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
