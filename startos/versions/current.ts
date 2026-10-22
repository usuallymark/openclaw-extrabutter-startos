import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:7',
  releaseNotes: {
    en_US: `Node.js security update.

- **Node.js 26.12.1**, the October 2026 security release. It fixes ten vulnerabilities, among them an out-of-bounds write in Brotli decompression (which the agent could reach by fetching Brotli-compressed web content) and three ways around TLS certificate hostname checks. The gateway, the webchat and the JavaScript skills all run on it; 2026.10.1:6 carried 26.12.0.
- Node is now pinned to an exact release, so each version of this package states which Node it ships.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
