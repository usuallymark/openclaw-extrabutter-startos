import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '2026.10.1:4',
  releaseNotes: {
    en_US: `Trilium on this server.

- **Trilium Notes can now be set to "On this server"** in Configure External Services, like Vaultwarden, n8n and the others. Install the Trilium package from the Marketplace, choose On this server, and enter only the ETAPI token (or fetch it from Vaultwarden); OpenClaw finds Trilium over the server's internal network, with no URL or certificate. It is listed as a dependency only while chosen, and the health check says so if it is not installed.
- Existing settings are unchanged: a Trilium you reach at an address stays "At an address", and its URL stays saved when you switch.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
