import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.9.9:1',
  releaseNotes: {
    en_US: `Fixes the gateway refusing to save anything after an agent was removed.

- **Removing an agent in Configure Agents no longer breaks the gateway.** The action ran OpenClaw's command-line tool in a temporary container, and with OpenClaw 2026.9.9 an agent removal made from there left the running gateway without its state lock: the removal failed ("state ownership … could not be verified") and the gateway then refused every state write (scheduled jobs, device pairing, cleanup) until it was restarted. Actions that run OpenClaw's command-line tool (Configure Agents, Approve Browser Pairing, Connect WhatsApp, Configure SimpleX) now run it inside the gateway's own container while the service is running.
- **Quieter logs.** The gateway no longer runs with verbose logging, which in OpenClaw 2026.9.9 wrote a scheduler line many times a second and pushed useful lines out of the service log.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
