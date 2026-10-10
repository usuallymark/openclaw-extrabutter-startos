import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// Package-private settings for OpenClaw's memory-search embeddings. Kept apart
// from the chat providers' auth profiles so that changing the chat provider
// never drops the embedding key. main.ts bridges `apiKey` to the provider's
// env var only when no chat key for the same provider is already set.
const shape = z.looseObject({
  provider: z.string().optional().catch(undefined),
  apiKey: z.string().optional().catch(undefined),
})

export const embeddingsJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '.startos/embeddings.json' },
  shape,
)
