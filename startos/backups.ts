import { sdk } from './sdk'

// Both volumes: `main` (/data: workspace, config, vault, cron) and `qdrant`
// (the vector collections). StartOS stops the service for the backup, so
// Qdrant's files are copied in a consistent state.
export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects }) => sdk.Backups.ofVolumes('main', 'qdrant'),
)
