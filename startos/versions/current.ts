import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:25',
  releaseNotes: {
    en_US: `Calendar: who made an event, told correctly.

- **Events on calendars shared with the assistant** were marked as made by the assistant's own account when their calendar's owner made them (and so was a holiday calendar's every event). Now only the account's own calendars count as its own; the owner of a shared calendar is checked against your Trusted Organizers like anyone else, and such events are marked as the calendar's own.
- The calendar agent's status now lists each calendar link and whether it can be read.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
