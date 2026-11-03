import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:27',
  releaseNotes: {
    en_US: `Security: the vault moves out of the agents' reach.

- **A separate vault service now holds Vaultwarden.** Until now every agent with a shell could read the master password and every vault item, including the email password and the Calendar sign-in, and so could send mail or change your calendar without the email and calendar services' rules and your approvals. Now rbw, its keys and the master password belong to the vault service alone; agents ask it.
- **Items that belong to a service go only to that service**: the email password (while Configure Email uses Gmail or IMAP), the Calendar sign-in and your calendar links' items (while Calendar is on). Every other item works for every agent as before (NAS, Crawl4AI, n8n, ntfy, Gitea and your own), through getcred and rbw get as before. Agents can no longer add, edit or delete vault items; do that in Vaultwarden.
- **Configure External Services' settings moved to a folder only the package can read**, so an agent can no longer change the Vaultwarden address it signs in to, your host mappings or your trusted certificates.
- Agent Activity lists which vault items were asked for and which were refused.
- The first start signs in to Vaultwarden again from a new place, so Vaultwarden may report a new device.

**After installing, change what the agents could read until now**: the mail app password (then save it in Vaultwarden or Configure Email), the Google Calendar sign-in (sign in again and remove the old access in your Google account), each calendar link's secret address, and your Vaultwarden master password (then enter it in Configure External Services).`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
