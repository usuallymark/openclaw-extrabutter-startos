import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v2026_9_9_0 } from './v2026_9_9_0'
import { v2026_9_9_1 } from './v2026_9_9_1'
import { v2026_9_9_2 } from './v2026_9_9_2'
import { v2026_10_1_0 } from './v2026_10_1_0'
import { v2026_10_1_1 } from './v2026_10_1_1'
import { v2026_10_1_2 } from './v2026_10_1_2'

export const versionGraph = VersionGraph.of({
  current,
  other: [
    v2026_10_1_2,
    v2026_10_1_1,
    v2026_10_1_0,
    v2026_9_9_2,
    v2026_9_9_1,
    v2026_9_9_0,
  ],
})
