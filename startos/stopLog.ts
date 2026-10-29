import { T } from '@start9labs/start-sdk'

// Stop logging (since 2026.10.1:15). Twice an update stuck at 80% with the
// old version never stopping, and StartOS logged nothing about why. StartOS
// stops a package in rounds and waits for every health check in a round
// to finish the run it is in, so one run that never ends holds up the
// whole stop. This wraps every check of the daemon chain to log, in the
// package log (start-cli package logs):
// - when the stop begins (the context is left), and which checks are mid-run;
// - every 15 s after that, the checks still running and for how long;
// - any check that finishes after the stop began, and how long it took;
// - any check run that takes longer than 30 s, stop or not.
// Only timing and check ids are logged, never results.

type Run = { id: string; started: number }

export function logStops<D>(effects: T.Effects, daemons: D): D {
  const running = new Map<number, Run>()
  let next = 0
  let leftAt = 0
  const secs = (ms: number) => `${Math.round(ms / 1000)} s`
  const busy = (now: number) =>
    [...running.values()]
      .map((r) => `${r.id} (${secs(now - r.started)})`)
      .join(', ') || 'none'

  effects.onLeaveContext(() => {
    leftAt = Date.now()
    console.info(`[stop] package stopping; checks mid-run: ${busy(leftAt)}`)
    const timer = setInterval(() => {
      if (!running.size) {
        console.info('[stop] no check is running any more')
        clearInterval(timer)
        return
      }
      console.info(
        `[stop] ${secs(Date.now() - leftAt)} after the stop began, still running: ${busy(Date.now())}`,
      )
    }, 15_000)
    ;(timer as any).unref?.()
  })

  for (const entry of ((daemons as any).entries ?? []) as any[]) {
    const ready = entry?.ready
    if (!ready || typeof ready !== 'object' || typeof ready.fn !== 'function')
      continue
    const id = String(entry.id)
    const fn = ready.fn
    ready.fn = async () => {
      const key = next++
      const started = Date.now()
      running.set(key, { id, started })
      const slow = setTimeout(
        () => console.warn(`[stop-log] check ${id} still running after 30 s`),
        30_000,
      )
      ;(slow as any).unref?.()
      try {
        return await fn()
      } finally {
        clearTimeout(slow)
        running.delete(key)
        const now = Date.now()
        if (leftAt && started <= now) {
          console.info(
            `[stop] check ${id} finished ${secs(now - leftAt)} after the stop began (ran ${secs(now - started)})`,
          )
        }
      }
    }
  }
  return daemons
}
