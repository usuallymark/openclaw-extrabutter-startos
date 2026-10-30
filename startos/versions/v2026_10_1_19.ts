import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_19 = VersionInfo.of({
  version: '2026.10.1:19',
  releaseNotes: {
    en_US: `Fix for updates that stall at 80%.

- **A health check that hangs no longer blocks stopping or updating the service.** Twice an update sat at 80% because the old version never stopped; the stop log showed why: two checks (Gitea and Ollama) had been stuck for hours, and the stop waited for them. Every check now gives up after 2 minutes (or 20 seconds once a stop has begun), shows as failed for that round and runs again as usual.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
