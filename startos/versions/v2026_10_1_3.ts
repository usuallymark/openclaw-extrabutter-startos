import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_10_1_3 = VersionInfo.of({
  version: '2026.10.1:3',
  releaseNotes: {
    en_US: `Services on this server.

- **New choice in Configure External Services: "On this server".** Vaultwarden, Ollama, n8n, SearXNG, Crawl4AI and ntfy can now each be set to Disabled, On this server, or At an address. On this server means the service is installed on this StartOS server: OpenClaw finds it over the server's internal network, with no URL, host mapping or certificate, and asks only for the credentials. Moving a service onto your server becomes a change of choice instead of a new URL.
- A service set to On this server is listed as a dependency, so StartOS shows when it is not installed or not running, and the health check says so plainly. If it is reinstalled and its internal address changes, OpenClaw restarts on its own to use the new one.
- Existing settings are unchanged (At an address), and the URL you had stays saved when you switch, for switching back.
- Trilium's link in the form now points to TriliumNext, where Trilium is developed.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
