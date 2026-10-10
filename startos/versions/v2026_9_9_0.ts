import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const v2026_9_9_0 = VersionInfo.of({
  version: '2026.9.9:0',
  releaseNotes: {
    en_US: `First release of OpenClaw Extra Butter (OpenClaw 2026.9.9).

A build of OpenClaw for StartOS with extra butter: a bundled Qdrant vector database, helper agents, optional connectors to your self-hosted services (Vaultwarden, Ollama, NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy), a mobile webchat, and PDF reading with OCR. It has its own package id, so it installs alongside the community OpenClaw package and never replaces it.`,
  },
  migrations: {
    up: async () => {},
    down: IMPOSSIBLE,
  },
})
