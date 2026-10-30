import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:18',
  releaseNotes: {
    en_US: `Agent Activity, and steadier warnings about hidden text.

- **Email Activity is now Agent Activity** and covers Calendar too: what the calendar agent read, added, changed and cancelled, what waited for you and your decisions, next to the email log. Each line says [Email] or [Calendar].
- **Hidden text is checked by the service itself.** Text a person would not see in an email (or an HTML event description) is still removed before the agent reads it; now it is also searched for instructions to an AI. A match sets a new warning, \`hidden_injection\`, which the agents pass on every time instead of depending on how they read the message.
- **Fewer false "hidden text" counts:** style sheets and HTML comments no longer count as hidden text.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
