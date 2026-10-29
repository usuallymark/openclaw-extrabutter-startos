import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_16 = VersionInfo.of({
  version: '2026.10.1:16',
  releaseNotes: {
    en_US: `Calendar: the assistant can keep a calendar of its own.

- **New mode in Configure Calendar: Read + write on its own calendar.** The calendar agent can add, move and cancel events on one calendar of its own (you name it), and invite you and your family. It still cannot change your calendars or answer invitations; Google itself refuses that.
- **Your approval for anything with guests.** Before Google emails anyone, the request waits in Review Agent Actions (a task appears), showing the event, the guests and why it waits. Optionally hold every new event, with or without guests. Only addresses on your trusted lists can be invited.
- **Trusted Organizers can reuse Email's Trusted Senders** (on by default), so the family's addresses are typed once.
- Write mode needs a new sign-in with one more permission; Instructions → Calendar Setup has the command.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
