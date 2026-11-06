import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_35 = VersionInfo.of({
  version: '2026.10.1:35',
  releaseNotes: {
    en_US: `Mail servers found automatically.

- **New in Configure Email: "Other provider (find servers automatically)".** Enter the address and password; saving finds the IMAP and SMTP servers the way Thunderbird does (the provider's own settings, Thunderbird's provider directory, your domain's mail server, DNS records) and saves them as "Other IMAP/SMTP provider", where you can see and change them. A Google address is saved as Gmail.
- **New action: Look Up Mail Servers.** Shows what would be found for an address, without saving anything.
- Only encrypted servers with password login are used, and the password is never part of the lookup. Outlook.com, Hotmail and Microsoft 365 no longer accept passwords from mail apps; the lookup says so instead of trying.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
