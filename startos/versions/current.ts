import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:42',
  releaseNotes: {
    en_US: `Releases are signed by one fixed key.

- **Until now every release was signed by a new, random key**, so StartOS could not be told to trust this package's releases. From this release on, all are signed by the same key, shown on each release's GitHub page.
- **On StartOS 0.4.1 and later:** add that key once under System → Trusted Keys → Add key (Packages on), and sideloading an update no longer asks "Install untrusted software?".`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
