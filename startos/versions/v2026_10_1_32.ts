import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_32 = VersionInfo.of({
  version: '2026.10.1:32',
  releaseNotes: {
    en_US: `Fix: the vault after 2026.10.1:31.

- **The vault found no master password after updating to :31.** The new contacts service's user was added to the image before the vault's, which changed the vault user's number, so its saved files (including the master password) no longer counted as its own. The service users now have fixed numbers (the same as before :31; contacts gets its own), and each service gives the files in its own folder back to its user at start. Nothing needs to be entered again.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
