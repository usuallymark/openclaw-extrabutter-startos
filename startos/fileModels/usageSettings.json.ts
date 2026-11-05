import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// Spending alert (since 2026.10.1:30). In the package's own folder (root
// only), next to Configure External Services' settings: the agents cannot
// change the limit.

export const USAGE_SETTINGS_SUBPATH = '.openclaw-package/usage.json'

const shape = z.looseObject({
  // Dollars per day; none: no alert.
  dailyLimit: z.number().positive().nullable().optional().catch(null),
})

export type UsageSettings = z.infer<typeof shape>

export const usageSettingsJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: USAGE_SETTINGS_SUBPATH },
  shape,
)
