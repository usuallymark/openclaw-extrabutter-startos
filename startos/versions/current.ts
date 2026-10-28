import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:9',
  releaseNotes: {
    en_US: `Fixes for the email agent (2026.10.1:8).

- **The email agent now gets its instructions.** 2026.10.1:8 wrote its instruction files (AGENTS.md, SOUL.md, IDENTITY.md) empty, so it worked without its rules and report format. Its limits were never affected: the tools it may use and what the mail service allows do not depend on those files.
- **The email agent's conversation is cleared after 15 minutes without requests**, so old mail does not pile up in it. Follow-up requests within a few minutes keep their context. (The main agent could not clear it when asked from the webchat.)
- A Vaultwarden "new device" mail mentioning rbw is no longer flagged as a suspected trick.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
