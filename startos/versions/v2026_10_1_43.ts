import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_43 = VersionInfo.of({
  version: '2026.10.1:43',
  releaseNotes: {
    en_US: `Works the same on StartOS 0.4.0.2 and later, 0.4.1 included.

- **No StartOS update needed.** This package still installs and runs on StartOS 0.4.0.2 and later. Its own uses of start-cli (Login to StartOS, Revoke StartOS Access, the Server Access line, the server snapshot) were checked against every StartOS from 0.4.0.2 to 0.4.1.2.
- **If you let the agent manage your server on StartOS 0.4.1 or later:** a few start-cli commands behave differently there (listing and ending sign-in sessions, installing from a signer your server does not trust). The agent now knows and points you to the web UI (System → Active Sessions, System → Trusted Keys) instead of retrying.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
