import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:22',
  releaseNotes: {
    en_US: `Routine mailings, and a say in self-learning.

- **Routine mailings:** approve a newsletter once with "Approve and make this a routine mailing" (Review Agent Actions), and later issues go out without asking when they match: the same recipients, a subject starting the same way, the same kind of attachments, not more often than allowed (one a month to begin with), no hidden instructions. You get a notification for each. Anything else still waits for you and says why. Manage them in Configure Email → Sending → Routine Mailings, with a Paused switch.
- **Self-learning in Configure Agents:** choose whether OpenClaw may change the skills it learned by itself (Automatic, OpenClaw's default), only propose changes for you to approve (recommended), or not learn at all.
- An HTML mail's page title no longer counts as hidden text.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
