import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_17 = VersionInfo.of({
  version: '2026.10.1:17',
  releaseNotes: {
    en_US: `Small Calendar fixes.

- **No false "someone else added this" warning** on events on the agent's own calendar.
- **The agent reports the exact saved times**, with the time zone, after adding, changing or cancelling an event (or when it waits for your approval).
- **Own Calendar Name now shows its default ("Assistant") as a real value** you can change, and explains how to rename the calendar later.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
