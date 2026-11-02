import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:24',
  releaseNotes: {
    en_US: `Calendar links: read your calendars without any Google setup.

- **Calendar Links in Configure Calendar.** Paste a calendar's secret iCal address (Google's "Secret address in iCal format", an iCloud public calendar link, an Outlook ICS link) or keep it in Vaultwarden, and the calendar agent can list, search and read those events. Read only, and no Google Cloud project or sign-in needed: choose *No Google account (calendar links only)*. Links also work next to a Google sign-in.
- Recurring events, moved or cancelled single dates and time zones are handled as in Google Calendar. The secret address never reaches the agents or the logs, and the agent marks these events as from a calendar link.
- The Calendar Service line now says how many calendar links can be read, with a warning for each one that cannot.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
