import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:23',
  releaseNotes: {
    en_US: `Routine mailings: per calendar month, and pick recipients from a list.

- **"At Most per Month" now means per calendar month** (it counted 30 days). Monthly issues sent on the 1st are sometimes only 28 to 30 days apart and would have waited for approval for no reason.
- **Pick a mailing's To and Bcc from a list** of the addresses you entered before (Trusted Senders, Send Automatically To, the calendar's Trusted Organizers) instead of typing them again; a field below each takes any other address.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
