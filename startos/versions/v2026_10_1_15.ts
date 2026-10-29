import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_15 = VersionInfo.of({
  version: '2026.10.1:15',
  releaseNotes: {
    en_US: `Calendar, read only.

- **New: Configure Calendar.** Your assistant can read the Google calendars of its account, including the ones you share with it: what is on, when something is, who invited whom. A separate calendar agent does the reading; it has only the calendar tools (no shell, no passwords, no web), and it cannot add, change, accept or delete anything. Off until you turn it on.
- **Invitations are treated like mail from strangers.** Event text is shown as untrusted content with hidden text removed, and each event says whether it came from the account itself, a Trusted Organizer, someone else, or an emailed invitation whose organizer can't be checked.
- **Sign in once on your computer** with the included script (tools/google-signin.py). It asks only to read calendars. Keep the sign-in in Vaultwarden or paste it in the form. The setup guide (Instructions → Calendar Setup) has every step, including the Google settings that stop invitations from strangers.
- **Stop logging.** If an update ever stalls at 80% again, the package log now shows which check the old version was waiting on.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
