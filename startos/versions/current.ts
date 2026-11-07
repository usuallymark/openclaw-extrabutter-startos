import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:40',
  releaseNotes: {
    en_US: `Health lines in a useful order; no more login nag.

- **The health lines are in a fixed order:** Web Interface, Webchat, Vault and Qdrant first, then Mail, Calendar and Contacts, then Spending and Server Access, and the external services last. StartOS sorts them by an internal name, which until now put Calendar and Contacts at the top and Mail among the external services.
- **No more "Login to StartOS" task at every start.** Leaving start-cli signed out is the safe choice, and the Server Access line already shows it. The action is still under Maintenance when you want it.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
