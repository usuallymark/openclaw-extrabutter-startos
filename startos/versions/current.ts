import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:44',
  releaseNotes: {
    en_US: `Easier report screens, and no more double events.

- **Agent Activity** has a small form: which service, which period (24 hours, 7 days, 30 days, everything) and changes only. The result starts with a one-line count of each service's changes; each part opens on its own.
- **Usage and Cost** starts with a one-line summary and opens each part on its own. It now names each agent's model and the form that sets it, and counts the contacts agent among the helpers.
- **Configure Calendar** shows under "Also Trust Email's Trusted Senders" who is trusted now: your Trusted Organizers together with Configure Email's Trusted Senders.
- **Calendar:** when a calendar link and a shared calendar show the same calendar, each event is listed once.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
