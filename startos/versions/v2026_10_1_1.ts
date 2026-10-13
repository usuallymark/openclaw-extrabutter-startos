import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_1 = VersionInfo.of({
  version: '2026.10.1:1',
  releaseNotes: {
    en_US: `Email, Google Calendar and Google Drive.

- **New: Configure External Services → Email.** One choice, three ways:
  - **Gmail (app password)**: the simplest way to give the agent a Gmail address (read, search, send, reply, file). Enter the address and a Google app password; Gmail's servers are filled in.
  - **Other IMAP/SMTP provider**: any mail service with IMAP and SMTP, including your own server (Custom Host Mappings and Custom CA apply).
  - **Google account (Gmail, Calendar, Drive)**: full Google access through a one-time sign-in made on your computer with gog. Instructions → Email Setup walks through it.
- **Every credential can live in Vaultwarden**: the email password (item "email", its login password), and for the Google account both the OAuth client and the sign-in token (item "google", fields client_json and token_json), loaded at every start. Or enter them in the form.
- **One naming standard for Vaultwarden**: one item per service, named in lowercase (email, nas, n8n, trilium, crawl4ai, ntfy, google); logins use their own username and password, keys go in a hidden custom field api_key. Lookups no longer depend on upper/lower case, so existing items such as "NAS" or "API_Key" keep working; rename them to the standard whenever convenient. The Vaultwarden option in Configure External Services now lists every name.
- New dashboard check for email: the IMAP server for the IMAP choices, "Signed in as …" for the Google account. The agent's health skill also tests the IMAP and SMTP logins and asks Google to confirm the sign-in.
- The image now includes himalaya 2.2.1 and gog 0.44.0, checksum-pinned for x86_64 and aarch64, with skills written for exactly those versions. OpenClaw's own bundled himalaya and gog skills stay off: the bundled himalaya one describes an older version.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
