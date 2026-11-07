import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_41 = VersionInfo.of({
  version: '2026.10.1:41',
  releaseNotes: {
    en_US: `Ready for StartOS 0.4.1; clearer help texts.

- **Server Access stays truthful on StartOS 0.4.1.** StartOS 0.4.1 changed an answer the line relied on, so a signed-in start-cli would have shown as "not signed in". The line now checks the sign-in in a way that works on every StartOS 0.4 release, and shows an unclear result as a warning instead of as signed out.
- **Server Access looks like what it means:** signed out (the safe choice) is a grey dash instead of a green check, and signed in, which gives the agent root on the server, is an orange warning.
- **Help texts corrected and shortened:** the calendar choices (now "Read + invitations by mail (no calendar account)"), calendar links, sending and routine mailings; the email and calendar agent models; the apps agent now mentions contacts.
- **Setup guide corrected:** the calendar account field's current name, the Vaultwarden items for calendar and contacts, troubleshooting the vault, and two StartOS 0.4.1 notes: confirming a sideloaded package, and API tokens to check under System → Active Sessions after Revoke StartOS Access.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
