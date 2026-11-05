import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:31',
  releaseNotes: {
    en_US: `Contacts, read only.

- **New: Configure Contacts.** Your assistant can look up your address book ("Sam's number", "who is this address?", "birthdays this month") through a new contacts agent, the only agent that reads contacts. Read only: nothing is ever changed.
- **Two sources:** a vCard file exported from any app (Google, iPhone, Outlook), imported into the contacts service's own folder where the agents cannot read it; or the contacts of the assistant's own Google account, with a sign-in that can only read contacts.
- New **Contacts Service** line on the service page.
- Usage and Cost: scheduled jobs now show their schedule, and jobs without an agent show "default (main)".`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
