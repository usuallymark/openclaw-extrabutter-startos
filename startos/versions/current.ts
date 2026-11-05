import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:34',
  releaseNotes: {
    en_US: `Fix: "in your contacts" for a contact just added.

- **A contact added in the assistant's Google account could be missed for a while.** When its copy was older than 15 minutes, the contacts check for mail and calendar answered from that old copy, while your assistant's own contacts lookup, a moment later, already saw the new contact. The contacts service now reads Google again every 15 minutes on its own, and a check that still finds an older copy waits briefly for the new one.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
