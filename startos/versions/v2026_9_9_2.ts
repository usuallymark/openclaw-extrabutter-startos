import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_9_9_2 = VersionInfo.of({
  version: '2026.9.9:2',
  releaseNotes: {
    en_US: `Small polish.

- **Repair OpenClaw shows doctor's findings as readable lines** (severity, message, the setting involved and the suggested fix), followed by the full report. Doctor prints its report as a single line of JSON.
- **The configuration now records what the package runs**: a local gateway (\`gateway.mode: local\`) bound to the LAN (\`gateway.bind: lan\`). Doctor no longer warns that the gateway mode is unset or that the gateway is loopback-only; it now notes, correctly, that the gateway is reachable on your network, behind its password and the per-browser approval.
- Configure Webchat's description says what saving does: the webchat starts or stops, and the rest of OpenClaw keeps running.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
