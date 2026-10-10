import { setupManifest } from '@start9labs/start-sdk'
import { START_CLI_VERSION, QDRANT_VERSION } from '../utils'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'openclaw-extrabutter',
  title: 'OpenClaw Extra Butter',
  license: 'MIT',
  packageRepo: 'https://github.com/usuallymark/openclaw-extrabutter-startos',
  upstreamRepo: 'https://github.com/openclaw/openclaw',
  marketingUrl: 'https://github.com/openclaw/openclaw',
  donationUrl: null,
  // Shown before StartOS downloads an update from a matching installed
  // version. Point `sourceVersion` at the releases that bundle an older
  // OpenClaw whenever OPENCLAW_VERSION changes (see UPDATING.md): those
  // updates migrate the agent databases, which cannot be undone.
  preDownloadAlert: {
    message: {
      en_US:
        'This update brings a new OpenClaw version. On its first start it migrates the agent databases (1–2 minutes), which cannot be undone. **Make a StartOS backup of OpenClaw Extra Butter before updating.**',
    },
    when: { sourceVersion: '<2026.9.9:0' },
  },
  description: { short, long },
  volumes: ['main', 'qdrant'],
  images: {
    openclaw: {
      source: {
        dockerBuild: {
          workdir: '.',
          buildArgs: {
            START_CLI_VERSION,
          },
        },
      },
      arch: ['x86_64', 'aarch64'],
    },
    qdrant: {
      source: { dockerTag: `qdrant/qdrant:${QDRANT_VERSION}` },
      arch: ['x86_64', 'aarch64'],
    },
  },
})
