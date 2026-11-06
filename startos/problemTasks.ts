// Fix-it tasks (since 2026.10.1:39): when a service's own sign-in is
// refused (the mailbox refused the password, Google or the CalDAV server
// refused the sign-in), the service page gets a task that opens the form
// where it is fixed, with the service's own reason (which says whether the
// new password goes into Vaultwarden or into the form). The red health line
// alone said what was wrong but not where to go.
//
// One task per service (replay ids below), raised by that service's health
// check side job and cleared by it once the service is no longer refused.
// The task is raised again every 10 minutes while the refusal lasts, so
// running the action without fixing anything does not make it go away for
// good. A service that is turned off runs no check; main clears its task at
// start (clearOffProblemTasks).

export const PROBLEM_TASKS = {
  mail: 'fix-mail',
  calendar: 'fix-calendar',
  contacts: 'fix-contacts',
} as const

export type ProblemService = keyof typeof PROBLEM_TASKS

export const REASSERT_MS = 10 * 60_000
const MAX_REASON = 300

const raised = new Map<ProblemService, { reason: string; at: number }>()
const clearedOnce = new Set<ProblemService>()

/** The task's text from a service's /healthz: a string while its own
 * sign-in is refused, null when nothing needs the owner, undefined while it
 * is starting or reloading (leave the task as it is: a refused service
 * exits every 10 minutes to fetch the password again). Only refusals: an
 * unreachable server fixes itself. */
export function problemReason(
  svc: ProblemService,
  h: any,
): string | null | undefined {
  if (!h || h.state === 'starting' || h.state === 'reloading') return undefined
  const cap = (s: string) =>
    s.length > MAX_REASON ? s.slice(0, MAX_REASON - 1) + '…' : s
  const label = { mail: 'Email', calendar: 'Calendar', contacts: 'Contacts' }[
    svc
  ]
  if (h.state === 'refused')
    return cap(`${label}: ${String(h.reason || 'the sign-in was refused')}`)
  // A refused CalDAV password while calendar links still work: the service
  // stays "ok" for the links (since :37), the account is stopped.
  if (svc === 'calendar' && h.state === 'ok' && h.caldavRefused)
    return cap(`${label}: ${String(h.caldavRefused)}`)
  return null
}

/** What to do with a service's task now: 'raise', 'clear' or null.
 * Call problemTaskDone after doing it. Exported for tests. */
export function problemTaskChange(
  svc: ProblemService,
  reason: string | null | undefined,
  now = Date.now(),
): 'raise' | 'clear' | null {
  if (reason === undefined) return null
  const prev = raised.get(svc)
  if (reason) {
    if (prev && prev.reason === reason && now - prev.at < REASSERT_MS)
      return null
    return 'raise'
  }
  // Cleared once per start even when this start raised nothing: a task
  // from before the restart may still be there.
  if (prev || !clearedOnce.has(svc)) return 'clear'
  return null
}

export function problemTaskDone(
  svc: ProblemService,
  reason: string | null | undefined,
  now = Date.now(),
) {
  if (reason === undefined) return
  if (reason) {
    raised.set(svc, { reason, at: now })
  } else {
    raised.delete(svc)
    clearedOnce.add(svc)
  }
}
