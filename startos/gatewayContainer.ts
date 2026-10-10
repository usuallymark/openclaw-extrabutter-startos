import { SubContainer, T } from '@start9labs/start-sdk'
import { manifest } from './manifest'
import { sdk } from './sdk'
import { mainMounts } from './utils'

type Sub = SubContainer<typeof manifest>

// The subcontainer the gateway daemon runs in, while main is running.
//
// Actions that run the `openclaw` CLI must run it here, not in a fresh
// temporary subcontainer: OpenClaw 2026.9.9 checks and reclaims its state
// lock files, and an agent change (config patch, then agents delete) made
// from a temporary subcontainer leaves the running gateway without its lock
// in /data/.openclaw/tmp/openclaw-<uid>/. From then on the gateway refuses
// every state write ("state ownership ... could not be verified") until it
// restarts. The same commands run in the gateway's own subcontainer (as an
// attach shell does) leave the lock alone.
let current: Sub | null = null

/** Called by main once the gateway's subcontainer exists. */
export function setGatewayContainer(effects: T.Effects, sub: Sub) {
  current = sub
  effects.onLeaveContext(() => {
    if (current === sub) current = null
  })
}

/**
 * Run `fn` in the gateway's subcontainer while the service runs; otherwise
 * (stopped, starting, or the subcontainer is gone) in a temporary one, where
 * there is no live gateway to race.
 */
export async function inOpenclawContainer<R>(
  effects: T.Effects,
  name: string,
  fn: (sub: Sub) => Promise<R>,
): Promise<R> {
  const sub = current
  if (sub) {
    let release: (() => Promise<void>) | null = null
    try {
      release = sub.hold()
    } catch {
      release = null
    }
    if (release) {
      console.info(`${name}: running in the gateway's container`)
      try {
        return await fn(sub)
      } finally {
        await release()
      }
    }
  }
  console.info(`${name}: running in a temporary container`)
  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'openclaw' },
    mainMounts(),
    name,
    fn,
  )
}
