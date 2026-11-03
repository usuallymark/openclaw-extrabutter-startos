import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { linkSafe } from '../noLinks'

// start-cli config.yaml shape - only validate what we care about
const shape = z.looseObject({
  host: z.string().optional().catch(undefined),
})

const startCliConfigYamlRaw = FileHelper.yaml(
  { base: sdk.volumes.main, subpath: '.startos/config.yaml' },
  shape,
)

// Writes clear any link on the way first (noLinks.ts): the folder is the
// gateway user's.
export const startCliConfigYaml = linkSafe(
  startCliConfigYamlRaw,
  '.startos/config.yaml',
)
