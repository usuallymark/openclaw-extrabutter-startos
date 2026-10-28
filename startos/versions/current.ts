import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:10',
  releaseNotes: {
    en_US: `The email agent can send, under your rules.

- **Configure Email → Sending.** Off (read only), Drafts only (the default, as before), or Send by rules: Send Automatically To (addresses, or whole domains written @example.com), Never Send To, and what happens with Anyone Else: Ask me (recommended), Block, or Send automatically. Limits per hour, per day and per message.
- **Every recipient is checked** (To, Cc and Bcc). Anyone on Never Send To: refused. A forward, any attachment, or a limit reached: waits for your approval. Everyone on the automatic list: sent. Only drafts the email agent made itself can be sent.
- **New action: Review Outgoing Mail.** Mail waiting for you raises a task, a StartOS notification and an ntfy alert. You see the recipients, subject, opening lines, attachments and why it waits, and choose Approve, Reject, or Approve and always allow these recipients. Undecided mail expires after 3 days; a draft changed in your mail app meanwhile is not sent.
- **New action: Email Activity**: what the email agent read, filed, drafted and sent, what the rules held or refused, and your decisions (no message text).
- **Attachments on outgoing mail**: the main agent puts files in the workspace folder mail-outbox. Mail with attachments always waits for approval.
- **The Mail Service line no longer shows "starting" for 3 minutes** when the password is refused: the state shows as soon as the service answers. It also shows the sending level and how many messages wait for you.
- **Passwords off command lines.** Provider API keys and other secrets reach the gateway through a private file instead of the start command, so they no longer show in the server's process list; the Google sign-in keyring password and the StartOS login password are passed on standard input.
- The email agent is told that a verified sender does not make a message's content safe, and says which folder it searched.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
