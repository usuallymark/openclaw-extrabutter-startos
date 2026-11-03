import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_26 = VersionInfo.of({
  version: '2026.10.1:26',
  releaseNotes: {
    en_US: `Security fixes only.

- **Webchat: every profile needs a PIN.** The webchat reaches the main agent and all its tools, and a profile without a PIN was open to anyone who could reach its address. Such a profile is now closed until it has one; Configure Webchat will not save a profile without a PIN, and new PINs are 6 to 12 digits. If ntfy is set up, you are notified when someone keeps entering wrong PINs.
- **The email and calendar services hold their rules against the main agent's shell.** The agent's user could rename the services' folders and put its own sending rules and approvals in their place, or make the package write into them through a link, and a race in the mail service's start could give it root in the container. All three are closed: /data now belongs to root (sticky), the package removes links before writing into the agent's folders, the services accept only rules and approvals exactly as the package writes them, and the mail service's start changes files by descriptor.
- **Never Send To** now also blocks the same address written another way (sam+anything@, Gmail with dots) and, for @domain, its subdomains.
- **HTML mail** checks also refuse CSS escapes, image-set(), @font-face, comments holding markup (Outlook shows <!--[if mso]> blocks), and links that a browser would open somewhere other than the domain shown; international domains are shown in their xn-- form in Review Agent Actions.
- **Calendar links:** a whole download ends after 30 seconds however slowly the server sends; a link never reaches this server itself, and reaches your own network only when the link itself is there (never by a redirect). A feed whose recurring events repeat absurdly often can no longer keep the calendar busy for minutes per question.
- **Server Access** health line: while start-cli is signed in (Login to StartOS), it warns that the agent then has root on the whole server, so the email and calendar rules do not hold against it.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
