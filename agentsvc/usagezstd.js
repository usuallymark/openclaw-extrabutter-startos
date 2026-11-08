'use strict'
// usagezstd.js (since 2026.10.1:45): the model usage in OpenClaw's
// compressed transcript rows, for agentctl.py usage.
//
// OpenClaw 2026.10 stores every transcript event of 1 KB or more
// zstd-compressed (transcript_events.event_zstd); only a summary without
// the usage stays readable (navigation_json). The image's Python has no
// zstd, Node has (and SQLite), so agentctl.py asks this script.
//
//   node usagezstd.js CUT_SECONDS DB...
//
// Prints one JSON object: { "<db>": { "rows": [[created_at, [usage, ...]],
// ...] } or { "error": "..." } }. Only rows newer than CUT_SECONDS and only
// usage objects with a numeric cost.total; never any message text. Opens
// each database read only.

const { DatabaseSync } = require('node:sqlite')
const zlib = require('zlib')

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function* usages(o) {
  if (Array.isArray(o)) {
    for (const v of o) yield* usages(v)
  } else if (o && typeof o === 'object') {
    const u = o.usage
    if (u && typeof u === 'object' && !Array.isArray(u)) yield u
    for (const [k, v] of Object.entries(o))
      if (k !== 'usage' && v && typeof v === 'object') yield* usages(v)
  }
}

function sinceValue(sample, cut) {
  if (typeof sample === 'number' || typeof sample === 'bigint')
    return Number(sample) > 1e11 ? cut * 1000 : cut
  return new Date(cut * 1000).toISOString().slice(0, 19)
}

function read(path, cut) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const cols = db
      .prepare('pragma table_info(transcript_events)')
      .all()
      .map((r) => r.name)
    if (!cols.includes('event_zstd') || !cols.includes('created_at'))
      return { rows: [] }
    const last = db
      .prepare(
        'select created_at from transcript_events order by rowid desc limit 1',
      )
      .get()
    if (!last) return { rows: [] }
    const rows = []
    let bad = 0
    const q = db.prepare(
      'select created_at, event_zstd from transcript_events where event_zstd is not null and created_at >= ?',
    )
    for (const r of q.iterate(sinceValue(last.created_at, cut))) {
      let ev
      try {
        ev = JSON.parse(zlib.zstdDecompressSync(r.event_zstd).toString('utf8'))
      } catch {
        bad++
        continue
      }
      const found = []
      for (const u of usages(ev)) {
        const c = u.cost
        if (!c || typeof c !== 'object' || typeof c.total !== 'number') continue
        found.push({
          cost: { total: num(c.total) },
          input: num(u.input),
          output: num(u.output),
          cacheRead: num(u.cacheRead),
          cacheWrite: num(u.cacheWrite),
        })
      }
      if (found.length) {
        const t = r.created_at
        rows.push([typeof t === 'bigint' ? Number(t) : t, found])
      }
    }
    return bad ? { rows, unreadable: bad } : { rows }
  } finally {
    db.close()
  }
}

const cut = Number(process.argv[2])
const out = {}
if (!Number.isFinite(cut)) {
  process.stderr.write('usage: node usagezstd.js CUT_SECONDS DB...\n')
  process.exit(2)
}
for (const path of process.argv.slice(3)) {
  try {
    out[path] = read(path, cut)
  } catch (e) {
    out[path] = { error: String((e && e.code) || (e && e.name) || 'error') }
  }
}
process.stdout.write(JSON.stringify(out))
