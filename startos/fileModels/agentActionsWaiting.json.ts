import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// How many agent actions wait for the owner (since 2026.10.1:38), written
// by the health checks in the same step that raises or clears the Review
// Agent Actions task, so the action is greyed out exactly while there is no
// task. In the package's own folder (root only): an agent cannot make the
// action look empty. A missing file (first start, or every service off)
// counts as unknown and leaves the action open.

export const AGENT_ACTIONS_WAITING_SUBPATH =
  '.openclaw-package/agent-actions.json'

const shape = z.looseObject({
  waiting: z.number().int().min(0).nullable().optional().catch(null),
})

export const agentActionsWaitingJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: AGENT_ACTIONS_WAITING_SUBPATH },
  shape,
)
