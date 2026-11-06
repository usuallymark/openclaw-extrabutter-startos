import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:38',
  releaseNotes: {
    en_US: `Tidier actions, safer approvals.

- **Actions are grouped:** Daily (Review Agent Actions, Agent Activity, Usage and Cost, Spending Alert), Email, Calendar, Contacts, Setup, Channels and Maintenance.
- **Review Agent Actions picks no decision for you.** Choose the request, and its details (recipients, subject, why it waits, when it expires) are shown right under the Decision field. Only the choices that apply are offered: calendar requests get Approve or Reject; "make this a routine mailing" is greyed out, with the reason, for replies, forwards, invitations and mail without a subject.
- **Review Agent Actions is greyed out while nothing waits**, and opens again when an agent asks (the task appears at the same time).`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
