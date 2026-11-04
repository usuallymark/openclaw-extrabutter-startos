import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:28',
  releaseNotes: {
    en_US: `Invitations by mail: add events to your calendars without Google.

- **New Calendar choice in Configure Calendar: "Read + invitations by mail"** (without a Google account). When you ask for an event, the calendar agent sends a normal calendar invitation by email to its guests (you and the people on your trusted lists), and their calendar apps put it on their calendars. Changes and cancellations go out as updates.
- **Your mail rules decide:** invitations are sent by the mail service like any other mail. Never Send To always wins, addresses on Send Automatically To get them straight away, anyone else waits for you in Review Agent Actions, and "Hold Every New Event" holds them all. The calendar service never gets the email password.
- **Answers are filed:** your guests' replies (accepted, declined) to these invitations are moved out of the Inbox into the folder "Calendar Replies".
- **Time Zone** setting in Configure Calendar for use without a Google account.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
