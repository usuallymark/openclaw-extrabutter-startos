import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:36',
  releaseNotes: {
    en_US: `Fix: Fastmail found again.

- **Look Up Mail Servers and "find servers automatically" said Fastmail needs a browser sign-in.** Fastmail's own settings file now offers only that, but Fastmail still accepts app passwords, and Thunderbird's provider directory lists them. The lookup now goes on to the other sources when one offers only a sign-in, and reports the sign-in only when no source offers a password login.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
