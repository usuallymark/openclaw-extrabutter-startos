import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:45',
  releaseNotes: {
    en_US: `Usage and Cost now counts every model call.

- **Usage and Cost, the Spending line and the Spending Alert showed too little.** OpenClaw 2026.10 stores longer replies compressed, and those were not counted, often about a third of the cost. They are now. Expect the figures, and the daily total the alert compares with your limit, to go up; check your Spending Alert limit.
- **Long app reports:** the apps agent asks for compact reports when a job may list many messages or events, and the main agent asks again for a narrower job instead of guessing when a report arrives cut off.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
