import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_12 = VersionInfo.of({
  version: '2026.10.1:12',
  releaseNotes: {
    en_US: `Fix for email attachments.

- **Attachments on outgoing mail work.** Drafts with a file from the workspace folder mail-outbox failed with "Permission denied": the mail service runs as its own user, which cannot pass through OpenClaw's private folder (/data/.openclaw). The mail service now gets the two mail folders handed over when it starts, so OpenClaw's folder stays private.
- The same applies to copying attachments from trusted senders into mail-inbox.
- File errors are reported to the email agent in plain words instead of a bare error name.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
