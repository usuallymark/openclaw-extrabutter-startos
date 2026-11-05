import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_30 = VersionInfo.of({
  version: '2026.10.1:30',
  releaseNotes: {
    en_US: `Usage and Cost: see what the AI models cost.

- **New action: Usage and Cost.** The model cost per agent (today, 7 and 30 days, with tokens and the model each uses), per day for the last two weeks, and how often each scheduled job ran. The numbers are the ones OpenClaw records for every model call with the provider's prices; no message text is shown.
- **New Spending line** on the service page: today's and the week's cost, checked every 10 minutes.
- **New action: Spending Alert.** Set a daily limit; above it the Spending line turns red and you get one notification (and ntfy) that day.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
