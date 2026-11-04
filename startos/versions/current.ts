import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:29',
  releaseNotes: {
    en_US: `Configure Calendar: switching modes without surprises.

- **The Calendar choice now shows only the fields that mode needs.** Read only asks for the Google sign-in or none, Read + write (Google) for the sign-in and the own calendar's name, Read + invitations by mail (no Google) for the time zone. A half-finished switch can no longer be saved.
- **Switching back keeps what you had.** Each mode's fields keep their saved values (sign-in choice, own calendar name, time zone, hold setting) and come back as you left them.
- **Invitations by mail is greyed out until Configure Email can send them,** and the description says what is missing, instead of an error after Save.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
