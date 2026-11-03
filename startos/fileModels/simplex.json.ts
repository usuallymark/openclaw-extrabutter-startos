import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { linkSafe } from '../noLinks'

// StartOS-side state for the optional SimpleX Websocket Bridge integration:
// only whether file exchange with the bridge is enabled. Kept separate from
// OpenClaw's own `openclaw.json` so toggling it doesn't restart the gateway on
// unrelated config edits.
const shape = z.looseObject({
  enabled: z.boolean().catch(false),
})

const simplexJsonRaw = FileHelper.json(
  { base: sdk.volumes.main, subpath: '/simplex.json' },
  shape,
)

// Writes clear any link on the way first (noLinks.ts): the folder is the
// gateway user's.
export const simplexJson = linkSafe(simplexJsonRaw, 'simplex.json')
