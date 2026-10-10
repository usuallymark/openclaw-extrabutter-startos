import { T, z } from '@start9labs/start-sdk'
import * as fs from 'node:fs/promises'
import { sdk } from './sdk'
import { inOpenclawContainer } from './gatewayContainer'

export const uiPort = 18789
export const qdrantPort = 6333
// Webchat: public HTTP port (exported as an interface when enabled) and a
// loopback-only port the agent uses to hand files to the user.
export const webchatPort = 18800
export const webchatUploadPort = 18801

// start-cli release whose binary the image installs (see UPDATING.md).
export const START_CLI_VERSION = '2.2.0'

// Qdrant version pinned here so it is visible alongside openclaw's version pin
// in the Dockerfile. Bump both together when upgrading.
export const QDRANT_VERSION = 'v1.18.2'

export function mainMounts() {
  return sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: null,
    mountpoint: '/data',
    readonly: false,
  })
}

export function qdrantMounts() {
  return sdk.Mounts.of().mountVolume({
    volumeId: 'qdrant',
    subpath: null,
    mountpoint: '/qdrant/storage',
    readonly: false,
  })
}

// Doctor budgets 30s of integrity scans per database before it migrates anything.
export const DOCTOR_TIMEOUT_MS = 1_800_000

export const OPENCLAW_CLI_ENV = {
  HOME: '/data',
  OPENCLAW_STATE_DIR: '/data/.openclaw',
}

// `node` because OpenClaw refuses state and plugins the gateway's uid does not
// own; the timeout clears `exec`'s 30s SIGKILL default.
export async function runOpenclawCli(
  effects: T.Effects,
  name: string,
  args: string[],
  timeoutMs = 600_000,
) {
  return inOpenclawContainer(effects, name, (subc) =>
    subc.exec(['openclaw', ...args], {
      user: 'node',
      env: OPENCLAW_CLI_ENV,
      timeout: timeoutMs,
    }),
  )
}

const credentialsSchema = z.object({ apiKey: z.string() })

/**
 * Read the API key a dependency publishes on its `public` volume (e.g. vLLM's
 * `credentials.json`). Mounts that volume into a transient subcontainer via
 * `Mounts.mountDependency` — reading a dependency's volume needs no volume of
 * our own. A dependency mount is always a directory (StartOS refuses single-file
 * dependency mounts), so the whole volume is mounted and the file read from it.
 * Returns null if unavailable (dependency not installed/running, file missing,
 * or no key).
 */
export async function readDependencyApiKey(
  effects: T.Effects,
  dependencyId: string,
): Promise<string | null> {
  try {
    return await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'openclaw' },
      sdk.Mounts.of().mountDependency({
        dependencyId,
        volumeId: 'public',
        subpath: null,
        mountpoint: '/dep-public',
        readonly: true,
      }),
      `${dependencyId}-creds`,
      async (sub) => {
        const raw = await fs.readFile(
          sub.subpath('/dep-public/credentials.json'),
          'utf8',
        )
        return credentialsSchema.parse(JSON.parse(raw)).apiKey
      },
    )
  } catch {
    return null
  }
}
