import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// Configure Apps Agent (since 2026.10.1:20): the apps agent's display name,
// model and extra instructions. No secrets.

const shape = z.looseObject({
  name: z.string().catch('Apps'),
  model: z.string().catch('default'),
  extraInstructions: z.string().optional().catch(undefined),
})

export type AppsAgentSettings = z.infer<typeof shape>

export const APPS_AGENT_DEFAULTS: AppsAgentSettings = {
  name: 'Apps',
  model: 'default',
}

export const appsAgentJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '.startos/apps-agent.json' },
  shape,
)
