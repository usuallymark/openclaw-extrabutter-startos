import { mkdir } from 'fs/promises'
import { openclawJson } from '../fileModels/openclaw.json'
import { HEARTBEAT_PROMPT } from '../heartbeat'
import { startCliConfigYaml } from '../fileModels/startCliConfig.yaml'
import { sdk } from '../sdk'
import { mainMounts } from '../utils'

export const initializeService = sdk.setupOnInit(async (effects, kind) => {
  // Get the OS IP and set url to startos/config.yaml
  const osIp = await sdk.getOsIp(effects)
  const hostUrl = `https://${osIp}`

  await mkdir(sdk.volumes.main.subpath('.startos'), { recursive: true })

  await startCliConfigYaml.merge(effects, { host: hostUrl })

  // Seed the workspace bootstrap files only when they are missing. They are
  // the agent's identity and memory: once present they belong to the user
  // (and may be tracked in their own git repo), so updates must not replace
  // them.
  await mkdir(sdk.volumes.main.subpath('.openclaw/workspace/memory'), {
    recursive: true,
  })
  await sdk.SubContainer.withTemp(
    effects,
    { imageId: 'openclaw' },
    mainMounts(),
    'seed-workspace',
    async (subc) => {
      await subc.exec(
        [
          'sh',
          '-c',
          'for f in SOUL.md IDENTITY.md MEMORY.md; do test -e "/data/.openclaw/workspace/$f" || { cp "/opt/workspace/$f" "/data/.openclaw/workspace/$f" && chown node:node "/data/.openclaw/workspace/$f"; }; done',
        ],
        { user: 'root' },
      )
    },
  )

  // Ensure OpenClaw config has required values on disk (zod catches protect our reads,
  // but OpenClaw reads the JSON directly)
  await openclawJson.merge(effects, {
    gateway: {
      auth: { mode: 'password' },
      controlUi: {
        enabled: true,
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    agents: {
      defaults: {
        // The default route, `owner`, skips the run (`no-route`) until a chat channel has an owner.
        heartbeat: { every: '24h', target: 'none', prompt: HEARTBEAT_PROMPT },
      },
    },
    skills: {
      load: { extraDirs: ['/opt/skills'] },
    },
  })
})
