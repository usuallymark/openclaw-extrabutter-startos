import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_11 = VersionInfo.of({
  version: '2026.10.1:11',
  releaseNotes: {
    en_US: `Fix for 2026.10.1:10.

- **A restart no longer hangs, and no longer holds up a server reboot.** In 2026.10.1:10 the Mail Service check also raised the approval task, sent the alerts and cleared the email agent's idle conversation. StartOS waits for a running check before it stops a service, and a restart that began during one of those jobs waited for good; a server reboot then waited behind it. The check now only reads the mail service's state; the rest runs separately, with time limits, and never holds up a stop.
- **Configure Email → Sending → Send Automatically to Trusted Senders** (on by default): your Trusted Senders also count as Send Automatically To, so your own and your family's addresses need not be entered twice. Send Automatically To is for any other addresses.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
