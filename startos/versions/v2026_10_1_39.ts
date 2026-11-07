import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_39 = VersionInfo.of({
  version: '2026.10.1:39',
  releaseNotes: {
    en_US: `A refused sign-in now tells you where to fix it.

- **When the mailbox refuses the password, or Google or the CalDAV server refuses a calendar or contacts sign-in**, the service page gets a task that opens Configure Email, Configure Calendar or Configure Contacts. Its text says what was refused and where the new password or sign-in goes (Vaultwarden or the form).
- The task goes away by itself once the sign-in works again, and comes back within 10 minutes if you open the form without fixing it. A server that is only unreachable raises no task.
- Also for a CalDAV account whose password was refused while calendar links keep working.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
