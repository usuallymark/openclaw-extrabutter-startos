import { lstat, unlink } from 'fs/promises'
import { sdk } from './sdk'

// The package (root) writes some files inside folders the gateway user owns
// (/data/.openclaw, /data/.startos, the agents' workspaces). Writing follows
// symbolic links, and FileHelper even writes to the link's target, keeping
// that target's owner and mode. So a link the gateway user (or an agent with
// a shell) put in place of such a file, or of a folder on the way to it,
// would make the package write gateway-chosen content anywhere the package
// can write, including the mail and calendar services' rules and approvals.
//
// Before such a write, any link on the way is removed (and logged): nothing
// the package writes there is meant to be a link. At start, when no gateway
// process runs, this leaves no window; from an action, a brief one remains,
// which the services' own checks (exact keys in rules.json and decisions)
// cover.

const ROOT = sdk.volumes.main.path

/** Remove any symbolic link on the way to subpath (in the main volume),
 * the file itself included. Stops at the first part that does not exist. */
export async function clearLinks(subpath: string): Promise<void> {
  const parts = subpath.split('/').filter((p) => p && p !== '.')
  if (parts.includes('..'))
    throw new Error(`refusing a path with "..": ${subpath}`)
  let cur = ROOT
  for (const part of parts) {
    cur = `${cur}/${part}`
    let st
    try {
      st = await lstat(cur)
    } catch {
      return
    }
    if (st.isSymbolicLink()) {
      await unlink(cur)
      console.warn(
        `Removed a symbolic link at ${cur.slice(ROOT.length)} before writing there (the package never makes links there).`,
      )
      return
    }
    if (!st.isDirectory()) return
  }
}

/** Same, for an absolute path inside the main volume. */
export async function clearLinksAt(abs: string): Promise<void> {
  if (!abs.startsWith(ROOT + '/'))
    throw new Error(`not in the main volume: ${abs}`)
  await clearLinks(abs.slice(ROOT.length + 1))
}

const WRITES = new Set(['write', 'merge', 'update'])

/** A FileHelper whose writes first clear links on the way to its file. */
export function linkSafe<T extends object>(helper: T, subpath: string): T {
  return new Proxy(helper, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver)
      if (typeof v !== 'function') return v
      if (typeof key === 'string' && WRITES.has(key)) {
        return async (...args: any[]) => {
          await clearLinks(subpath)
          return v.apply(target, args)
        }
      }
      return v.bind(target)
    },
  })
}
