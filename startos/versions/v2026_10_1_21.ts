import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_21 = VersionInfo.of({
  version: '2026.10.1:21',
  releaseNotes: {
    en_US: `HTML mail, longer approvals with a reminder, calendar fixes.

- **The assistant can send HTML mail** (a newsletter, say). It writes the HTML into the workspace folder mail-outbox; pictures are files there too and are embedded in the mail. Pictures loaded from other websites, scripts, forms and hidden instructions are refused. HTML mail always waits for your approval, and Review Agent Actions shows where its links go, its pictures and any hidden text.
- **Waiting requests expire after 5 days instead of 3**, for mail and calendar, and you get a reminder (notification and ntfy) the day before.
- **Calendar:** the health line says "read + write" in write mode (it said "read only"), and the assistant's own calendar follows the account's time zone (a new account's calendar could start out in UTC).`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
