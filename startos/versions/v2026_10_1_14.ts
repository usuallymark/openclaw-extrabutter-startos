import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_14 = VersionInfo.of({
  version: '2026.10.1:14',
  releaseNotes: {
    en_US: `Groundwork for Calendar and other Google apps. Email works exactly as before.

- **Review Outgoing Mail is now Review Agent Actions.** It is the one place you approve what your agents want to do. Today that is still only mail held by your sending rules; later, things like calendar invitations will appear there too. Each request shows which agent it comes from. Mail waiting from before the update is still listed and can be approved.
- **The mail service's building blocks are now shared**, so the next isolated services (Calendar first) are built the same way: their own user, no secrets in the agent's reach, and your approval for anything held.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
