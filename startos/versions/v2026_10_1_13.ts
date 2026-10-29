import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_13 = VersionInfo.of({
  version: '2026.10.1:13',
  releaseNotes: {
    en_US: `Small fix.

- **Email Activity shows the whole log**, line by line, with a copy button and a download (email-activity.txt). It showed everything squeezed into a single line before.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
