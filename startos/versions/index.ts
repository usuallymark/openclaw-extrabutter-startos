import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v2026_9_9_0 } from './v2026_9_9_0'
import { v2026_9_9_1 } from './v2026_9_9_1'

export const versionGraph = VersionGraph.of({
  current,
  other: [v2026_9_9_1, v2026_9_9_0],
})
