import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:33',
  releaseNotes: {
    en_US: `Known contacts in mail and calendar.

- **New: "in your contacts".** With an address book connected (Configure Contacts), your assistant now says when an email's sender or an event's organizer is in your contacts. That ranks below your trusted lists, and it is only said when the sender is checked: a mail your mail server verified, or an event made in Google.
- **A new warning:** when the address is in your contacts but the sender is not checked (an unverified mail, an emailed invitation), your assistant warns you that someone may be posing as that contact.
- The email and calendar services never see your contacts: they only ask the contacts service "is this address in the contacts?" and get yes or no.
- Mail lists and searches now show whether each sender was verified, without opening the message.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
