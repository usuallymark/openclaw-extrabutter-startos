import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:20',
  releaseNotes: {
    en_US: `New: the apps agent.

- **Your main agent now asks one apps agent about mail and calendars.** The apps agent passes each job to the email or calendar agent and brings their reports back unchanged. Your main agent carries one set of instructions instead of one per app, and the apps agent has nothing but that one job: no shell, no files, no passwords.
- **The email and calendar agents answer only requests that come through the apps agent.** If your main agent's own notes say to ask them directly, change that to the apps agent.
- **New action: Configure Apps Agent** for its name, model and extra instructions. A persona goes in its SOUL.md and IDENTITY.md.
- Configure Agents no longer lists the calendar agent (it is managed by Configure Calendar), like the email agent.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
