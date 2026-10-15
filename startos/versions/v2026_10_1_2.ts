import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_2 = VersionInfo.of({
  version: '2026.10.1:2',
  releaseNotes: {
    en_US: `Vault sync fix, and two email details.

- **Vault sync is checked and repaired.** rbw kept answering from its local copy of the vault when Vaultwarden stopped accepting its stored sign-in, so the vault looked healthy while items added or renamed in Vaultwarden never reached OpenClaw. Now:
  - At every start, a failed sync is logged, and if Vaultwarden itself is up, the package signs in to Vaultwarden again with the saved master password. If that does not help either, the previous local copy is kept, so lookups work as before.
  - The dashboard's "Vault (rbw)" check also syncs, and turns red when the sync fails. The agent's health skill reports the same.
  - A failed credential lookup now says why (for example "no entry found"), and whether the sync failed too.
- **Gmail app passwords work with or without their spaces.** Google shows them as four groups of four letters; the spaces are dropped when signing in.
- The instructions give the attach command with \`--name openclaw-sub\`, which skips the container question.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
