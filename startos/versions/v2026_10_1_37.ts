import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_37 = VersionInfo.of({
  version: '2026.10.1:37',
  releaseNotes: {
    en_US: `Calendars at iCloud, Fastmail, Nextcloud (CalDAV).

- **New in Configure Calendar: a CalDAV account** (iCloud, Fastmail, Nextcloud and other CalDAV servers) instead of Google, with an app password (pasted, or Vaultwarden item "caldav"). The server is found from your address (iCloud, Fastmail and Yahoo by name, otherwise the domain's own CalDAV address), or you enter it.
- **Read** every calendar of the account, like calendar links (repeating events, time zones, the same checks and warnings). **Write mode** keeps a calendar of the assistant's own on that account, under the same rules as with Google: guests only from your allowed list, anything with guests waits for your approval, and the server sends the invitations.
- A change is made only on the version the assistant last saw: if the event was changed on another device meanwhile, nothing is overwritten.
- HTTPS only; the password goes only to the calendar server itself, and one the server refused is not sent again.
- **New action: Look Up Calendar Server** shows the server and calendars that would be found, without saving anything.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
