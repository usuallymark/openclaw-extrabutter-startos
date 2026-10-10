#!/usr/bin/env node
// OpenClaw Webchat server.
//
// - Serves a per-profile chat UI at /u/<profileId>/.
// - Holds the ONLY gateway connection (loopback, password auth). Browsers talk
//   to this server over /u/<id>/ws using a small app protocol; they never see
//   gateway credentials and can only touch sessions under their own profile
//   prefix (agent:main:<profileId>).
// - Optional per-profile PIN, remembered per device with an HMAC cookie.
// - File hand-off: a loopback-only /upload endpoint for the agent; download
//   links on the public port expire after 24 h.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayClient } from '@openclaw/gateway-client'
import { WebSocketServer } from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const env = process.env
const PORT = Number(env.WEBCHAT_PORT || 18800)
const UPLOAD_PORT = Number(env.WEBCHAT_UPLOAD_PORT || 18801)
const HOST = env.WEBCHAT_HOST || '0.0.0.0'
const GW_URL = env.GW_URL || 'ws://127.0.0.1:18789'
const OPENCLAW_CONFIG = env.OPENCLAW_CONFIG || '/data/.openclaw/openclaw.json'
const DATA = env.WEBCHAT_DATA || '/data/.openclaw/webchat'
const CONFIG_FILE = path.join(DATA, 'config.json')
const STATE_DIR = path.join(DATA, 'state')
const UPLOADS = path.join(DATA, 'uploads')
const UI = path.join(HERE, 'ui')
const ASSETS = path.join(HERE, 'assets')
const AGENT = 'main'

const UPLOAD_MAX = 50 * 1024 * 1024
const UPLOAD_TTL = 24 * 3600 * 1000
const MAX_FAILS = 5
const BASE_LOCK_MS = 5 * 60 * 1000

const log = (...a) => console.log('[webchat]', ...a)

for (const d of [DATA, STATE_DIR, UPLOADS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

// ── Config ──────────────────────────────────────────────────────────────────
const ACCENTS = {
  gold: ['#c8a96e', '#1e1a14'],
  teal: ['#4a8b8c', '#101a1a'],
  violet: ['#8b6aae', '#17121d'],
  rose: ['#b86b7a', '#1d1214'],
  blue: ['#5b84b8', '#11161d'],
  green: ['#6f9a5c', '#121a10'],
}
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/

function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) {
    log('no config at', CONFIG_FILE, '- using a single default profile')
  }
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
    .filter((p) => p && ID_RE.test(p.id))
    .map((p) => ({
      id: p.id,
      name: String(p.name || p.id).slice(0, 60),
      accent: ACCENTS[p.accent] ? p.accent : 'gold',
      greeting: typeof p.greeting === 'string' ? p.greeting.trim() : '',
      presets: (Array.isArray(p.presets) ? p.presets : [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 100),
      pinHash: typeof p.pinHash === 'string' && p.pinHash ? p.pinHash : null,
      pinVersion: Number(p.pinVersion) || 0,
    }))
  if (!profiles.length) {
    profiles.push({ id: 'me', name: 'Me', accent: 'gold', greeting: '', presets: [], pinHash: null, pinVersion: 0 })
  }
  return {
    appName: String(raw.appName || 'OpenClaw').slice(0, 40),
    rememberDays: Number.isFinite(Number(raw.rememberDays)) ? Number(raw.rememberDays) : 90,
    profiles,
  }
}
const config = loadConfig()
const profilesById = new Map(config.profiles.map((p) => [p.id, p]))
const anyPin = config.profiles.some((p) => p.pinHash)
log(`profiles: ${config.profiles.map((p) => p.id + (p.pinHash ? ' (PIN)' : '')).join(', ')}`)

// All webchat sessions live under their own "wc-" namespace, so a profile id
// can never collide with OpenClaw's own session keys (agent:main:main,
// agent:main:cron:*, channel sessions, ...).
const defaultKey = (p) => `agent:${AGENT}:wc-${p.id}`
const KEY_RE = /^[A-Za-z0-9:._-]{1,200}$/
function ownsKey(p, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false
  const d = defaultKey(p)
  return key === d || key.startsWith(d + ':')
}
const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'chat'
const presetKey = (p, title) => `${defaultKey(p)}:${slugify(title)}-preset`
// "Fixed" conversations (General and each configured preset) have a stable
// base key. Clearing one archives its current session and points the base at
// a fresh key (the webchat runs with operator.read/write only; reset/delete
// would need operator.admin). st.remap: base key -> current key.
const currentKey = (p, st, base) => {
  const k = st.remap[base]
  return k && ownsKey(p, k) ? k : base
}
const fixedBases = (p) => [defaultKey(p), ...p.presets.map((t) => presetKey(p, t))]
const baseOf = (p, st, key) => fixedBases(p).find((b) => currentKey(p, st, b) === key) ?? null

// ── Secrets: cookie key ─────────────────────────────────────────────────────
function loadSecret() {
  const f = path.join(DATA, 'secret')
  try {
    const s = fs.readFileSync(f)
    if (s.length >= 32) return s
  } catch {}
  const s = crypto.randomBytes(32)
  fs.writeFileSync(f, s, { mode: 0o600 })
  return s
}
const SECRET = loadSecret()

// ── Per-profile state (names, deleted, created) ─────────────────────────────
function stateFile(id) {
  return path.join(STATE_DIR, `${id}.json`)
}
function readState(id) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'))
    const remap = s.remap || {}
    // 2026.9.4:4 kept only General's moved key, as `general`.
    if (s.general && !remap[`agent:${AGENT}:wc-${id}`]) remap[`agent:${AGENT}:wc-${id}`] = s.general
    return { names: s.names || {}, deleted: s.deleted || [], created: s.created || [], remap, primed: s.primed || {} }
  } catch {
    return { names: {}, deleted: [], created: [], remap: {}, primed: {} }
  }
}
function writeState(id, s) {
  const tmp = stateFile(id) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  fs.renameSync(tmp, stateFile(id))
}

// ── PIN + cookies ───────────────────────────────────────────────────────────
function verifyPin(pin, stored) {
  // stored: scrypt$<saltB64>$<hashB64>
  const parts = String(stored).split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'base64')
  const want = Buffer.from(parts[2], 'base64')
  const got = crypto.scryptSync(String(pin), salt, want.length)
  return crypto.timingSafeEqual(got, want)
}
const cookieName = (id) => `wc_${id}`
function makeCookie(p) {
  const exp = config.rememberDays > 0 ? Date.now() + config.rememberDays * 86400_000 : 0
  const body = `${p.id}.${p.pinVersion}.${exp}`
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${exp}.${mac}`
}
function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function hasValidCookie(req, p) {
  const v = parseCookies(req)[cookieName(p.id)]
  if (!v) return false
  const [expStr, mac] = v.split('.')
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || (exp !== 0 && exp < Date.now())) return false
  const body = `${p.id}.${p.pinVersion}.${exp}`
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  const a = Buffer.from(String(mac || ''))
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
const authorized = (req, p) => !p.pinHash || hasValidCookie(req, p)

const lockouts = new Map() // `${id}|${ip}` -> { fails, until, strikes }
const profileFails = new Map() // id -> { times: number[], until }
const PROFILE_WINDOW_MS = 10 * 60 * 1000
const PROFILE_MAX_FAILS = 20
const PROFILE_LOCK_MS = 15 * 60 * 1000
// The StartOS proxy appends the real client address to X-Forwarded-For, so
// trust only the LAST entry (earlier ones are whatever the client sent).
function clientIp(req) {
  const parts = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return parts.at(-1) || req.socket.remoteAddress || '?'
}
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of lockouts) if (v.until < now && v.fails === 0) lockouts.delete(k)
  for (const [k, v] of profileFails) {
    v.times = v.times.filter((t) => now - t < PROFILE_WINDOW_MS)
    if (!v.times.length && v.until < now) profileFails.delete(k)
  }
}, 600_000).unref()

// ── Gateway connection ──────────────────────────────────────────────────────
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const rawPublicKey = (pem) =>
  crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length)

function loadOrCreateIdentity() {
  const f = path.join(DATA, 'device.json')
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const deviceId = crypto.createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex')
  const id = { deviceId, publicKeyPem, privateKeyPem }
  fs.writeFileSync(f, JSON.stringify(id), { mode: 0o600 })
  return id
}
const identity = loadOrCreateIdentity()
const tokenFile = path.join(DATA, 'device-token.json')
const readTokens = () => {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  } catch {
    return {}
  }
}

function gatewayPassword() {
  if (env.GW_PASSWORD) return env.GW_PASSWORD
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'))?.gateway?.auth?.password
  } catch {
    return undefined
  }
}

let gwConnected = false
const gw = new GatewayClient({
  url: GW_URL,
  password: gatewayPassword(),
  clientName: 'gateway-client',
  clientDisplayName: 'OpenClaw Webchat',
  clientVersion: '1.0.0',
  platform: 'linux',
  mode: 'backend',
  role: 'operator',
  scopes: ['operator.read', 'operator.write'],
  hostDeps: {
    loadOrCreateDeviceIdentity: () => identity,
    signDevicePayload: (pem, payload) =>
      crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(pem)).toString('base64url'),
    publicKeyRawBase64UrlFromPem: (pem) => rawPublicKey(pem).toString('base64url'),
    loadDeviceAuthToken: ({ deviceId, role }) => readTokens()[`${deviceId}:${role}`] ?? null,
    storeDeviceAuthToken: ({ deviceId, role, token, scopes }) => {
      const all = readTokens()
      all[`${deviceId}:${role}`] = { token, scopes }
      fs.writeFileSync(tokenFile, JSON.stringify(all), { mode: 0o600 })
    },
    clearDeviceAuthToken: ({ deviceId, role }) => {
      const all = readTokens()
      delete all[`${deviceId}:${role}`]
      fs.writeFileSync(tokenFile, JSON.stringify(all), { mode: 0o600 })
    },
    logError: (m) => log('gateway client:', m),
  },
  onHelloOk: () => {
    gwConnected = true
    log('connected to gateway')
    broadcastAll({ type: 'status', connected: true })
  },
  onConnectError: (e) => log('gateway connect error:', e?.message ?? e),
  onClose: (code) => {
    if (gwConnected) log('gateway connection closed', code)
    gwConnected = false
    broadcastAll({ type: 'status', connected: false })
  },
  onEvent: (evt) => onGatewayEvent(evt),
})
gw.start()

// ── Browser sockets ─────────────────────────────────────────────────────────
const sockets = new Map() // profileId -> Set<ws>
function broadcast(profileId, msg) {
  const data = JSON.stringify(msg)
  for (const ws of sockets.get(profileId) ?? []) if (ws.readyState === 1) ws.send(data)
}
function broadcastAll(msg) {
  for (const id of sockets.keys()) broadcast(id, msg)
}

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === 'string' ? p : p && (p.type === 'text' || p.text != null) ? p.text ?? '' : ''))
      .join('')
  if (typeof content === 'object') return textOf(content.content ?? content.text)
  return ''
}

function onGatewayEvent(evt) {
  if (evt.event !== 'chat') return
  const p = evt.payload ?? {}
  const key = p.sessionKey
  if (typeof key !== 'string') return
  for (const prof of config.profiles) {
    if (!ownsKey(prof, key)) continue
    const out = { type: 'event', event: 'chat', key, state: p.state, runId: p.runId }
    if (p.state === 'delta') {
      out.deltaText = p.deltaText ?? ''
      if (p.replace) out.replace = true
    } else if (p.state === 'final' || p.state === 'aborted') {
      out.text = textOf(p.message)
    } else if (p.state === 'error') {
      out.errorMessage = p.errorMessage ?? 'Agent error'
    } else if (p.state === 'status') {
      out.phase = p.phase
    }
    broadcast(prof.id, out)
  }
}

async function gwRequest(method, params) {
  if (!gwConnected) throw new Error('Not connected to OpenClaw')
  try {
    return await gw.request(method, params)
  } catch (e) {
    // OpenClaw >= 2026.9.5 refuses a session mutation when the session changed
    // underneath it (e.g. a label update racing the first message) and asks
    // for a retry. Requests carry idempotency keys, so one retry is safe.
    if (/SessionMutationAuthorizationChanged|retry the request/.test(String(e?.message ?? e))) {
      await new Promise((r) => setTimeout(r, 250))
      return gw.request(method, params)
    }
    throw e
  }
}

async function listConversations(p) {
  const st = readState(p.id)
  const deleted = new Set(st.deleted)
  const def = defaultKey(p)
  const gen = currentKey(p, st, def)
  const out = new Map()
  out.set(gen, { key: gen, name: st.names[def] || 'General', fixed: true, general: true })
  for (const title of p.presets) {
    const base = presetKey(p, title)
    const k = currentKey(p, st, base)
    if (deleted.has(base) || out.has(k)) continue
    out.set(k, { key: k, name: st.names[base] || title, fixed: true, preset: true })
  }
  let rows = []
  try {
    const res = await gwRequest('sessions.list', { limit: 500, agentId: AGENT })
    rows = res?.sessions ?? []
  } catch (e) {
    log('sessions.list failed:', e?.message ?? e)
  }
  const extra = []
  for (const r of rows) {
    const k = r?.key
    // Skip fixed conversations' own (current or retired) keys.
    if (!ownsKey(p, k) || out.has(k) || deleted.has(k) || r.archived || k === def || /:general-\d+$/.test(k) || /-preset(-\d+)?$/.test(k)) continue
    extra.push({
      key: k,
      name: st.names[k] || r.label || r.displayName || slugToName(k.slice(def.length + 1)),
      updatedAt: r.updatedAt ?? 0,
    })
  }
  for (const k of st.created) {
    if (!ownsKey(p, k) || out.has(k) || deleted.has(k) || extra.some((e) => e.key === k)) continue
    extra.push({ key: k, name: st.names[k] || slugToName(k.slice(def.length + 1)), updatedAt: Date.now() })
  }
  extra.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return [...out.values(), ...extra.map(({ key, name }) => ({ key, name }))]
}
function slugToName(slug) {
  const s = String(slug || '').replace(/-(preset|\d{8,})$/, '').replace(/-/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : 'Conversation'
}

async function history(p, key) {
  const res = await gwRequest('chat.history', { sessionKey: key, limit: 60 })
  const msgs = res?.messages ?? []
  const out = []
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.role === 'user' && typeof m.idempotencyKey === 'string' && m.idempotencyKey.startsWith('prime-')) continue
    const text = textOf(m.content)
    if (!text.trim()) continue
    out.push({ role: m.role, text, ts: m.timestamp ?? null })
  }
  return { messages: out, empty: msgs.length === 0 }
}

async function archiveSession(key) {
  const res = await gwRequest('sessions.list', { limit: 500, agentId: AGENT })
  const row = (res?.sessions ?? []).find((r) => r.key === key)
  if (!row || row.archived || !row.sessionId) return false
  await gwRequest('sessions.patch', { key, archived: true, expectedSessionId: row.sessionId })
  return true
}

// The conversation's topic: a preset's title (or its renamed name) or a named
// conversation's name. General has none.
function topicOf(p, st, key) {
  const base = baseOf(p, st, key)
  if (base === defaultKey(p)) return null
  if (base) return st.names[base] || p.presets.find((t) => presetKey(p, t) === base) || null
  return st.names[key] || null
}

// Hidden first message of a conversation: the profile's greeting with the
// topic filled in ({topic}), or with a topic line added. Sent once per
// conversation; skipped when the conversation already has messages.
function primeText(p, topic) {
  const g = (p.greeting || '').trim()
  if (g.includes('{topic}')) return topic ? g.replaceAll('{topic}', topic) : g.replace(/[^.!?\n]*\{topic\}[^.!?\n]*[.!?]?/g, '').trim() || null
  const line = topic ? `This conversation is about: ${topic}.` : ''
  return [g, line].filter(Boolean).join('\n\n') || null
}

const priming = new Map() // key -> Promise, so concurrent callers share one prime
function ensurePrimed(p, key) {
  if (priming.has(key)) return priming.get(key)
  const job = (async () => {
    const st = readState(p.id)
    if (st.primed[key]) return false
    const markDone = () => {
      const s2 = readState(p.id)
      s2.primed[key] = true
      writeState(p.id, s2)
    }
    const topic = topicOf(p, st, key)
    const text = primeText(p, topic)
    const h = await gwRequest('chat.history', { sessionKey: key, limit: 1 })
    if (!text || (h?.messages ?? []).length) {
      markDone()
      return false
    }
    await gwRequest('chat.send', { sessionKey: key, message: text, idempotencyKey: `prime-${key}`.slice(0, 200) })
    markDone()
    if (topic) await gwRequest('sessions.patch', { key, label: topic.slice(0, 80) }).catch(() => {})
    return true
  })().finally(() => priming.delete(key))
  priming.set(key, job)
  return job
}

// App protocol handlers. Every key is checked against the profile prefix.
const handlers = {
  async 'convs.list'(p) {
    return { convs: await listConversations(p) }
  },
  async 'convs.create'(p, { name }) {
    const title = String(name || '').trim().slice(0, 80) || 'New conversation'
    const key = `${defaultKey(p)}:${slugify(title)}-${Math.floor(Date.now() / 1000)}`
    const st = readState(p.id)
    st.names[key] = title
    st.created.push(key)
    writeState(p.id, st)
    return { key, name: title }
  },
  async 'convs.rename'(p, { key, name }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    const title = String(name || '').trim().slice(0, 80)
    if (!title) throw new Error('name required')
    const st = readState(p.id)
    st.names[baseOf(p, st, key) ?? key] = title
    writeState(p.id, st)
    gwRequest('sessions.patch', { key, label: title }).catch(() => {})
    return { ok: true }
  },
  async 'convs.delete'(p, { key }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    const st = readState(p.id)
    const base = baseOf(p, st, key)
    if (base) {
      // General or a preset: clear (archive + fresh key), never remove.
      await archiveSession(key).catch((e) => log('archive failed:', e?.message))
      const next = base === defaultKey(p) ? `${base}:general-${Date.now()}` : `${base}-${Date.now()}`
      st.remap[base] = next
      writeState(p.id, st)
      return { ok: true, cleared: true, key: next }
    }
    await archiveSession(key).catch((e) => log('archive failed:', e?.message))
    if (!st.deleted.includes(key)) st.deleted.push(key)
    st.created = st.created.filter((k) => k !== key)
    delete st.names[key]
    writeState(p.id, st)
    return { ok: true }
  },
  async 'chat.history'(p, { key }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    return history(p, key)
  },
  async 'chat.send'(p, { key, text }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    const message = String(text ?? '')
    if (!message.trim()) throw new Error('empty message')
    if (message.length > 100_000) throw new Error('message too long')
    // The topic/greeting always goes first, even if the person types before
    // the page sent it.
    await ensurePrimed(p, key).catch((e) => log('prime failed:', e?.message))
    const res = await gwRequest('chat.send', {
      sessionKey: key,
      message,
      idempotencyKey: 'wc-' + crypto.randomUUID(),
    })
    return { runId: res?.runId ?? null }
  },
  async 'chat.prime'(p, { key }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    return { primed: await ensurePrimed(p, key) }
  },
  async 'chat.abort'(p, { key }) {
    if (!ownsKey(p, key)) throw new Error('forbidden')
    await gwRequest('chat.abort', { sessionKey: key })
    return { ok: true }
  },
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
wss.on('connection', (ws, req, profile) => {
  let set = sockets.get(profile.id)
  if (!set) sockets.set(profile.id, (set = new Set()))
  set.add(ws)
  ws.send(JSON.stringify({ type: 'status', connected: gwConnected }))
  ws.on('close', () => set.delete(ws))
  ws.on('message', async (data) => {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (!msg || msg.type !== 'req' || typeof msg.method !== 'string') return
    const h = Object.prototype.hasOwnProperty.call(handlers, msg.method) ? handlers[msg.method] : null
    const reply = (obj) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'res', id: msg.id, ...obj }))
    if (!h) return reply({ ok: false, error: 'unknown method' })
    try {
      reply({ ok: true, payload: await h(profile, msg.params ?? {}) })
    } catch (e) {
      reply({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
    }
  })
})
// Keep-alive so proxies don't drop idle sockets.
setInterval(() => {
  for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.ping()
}, 30_000).unref()

// ── HTTP: public port ───────────────────────────────────────────────────────
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers })
  res.end(body)
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const template = (name) => fs.readFileSync(path.join(UI, name), 'utf8')
const APP_HTML = template('app.html')
const LOGIN_HTML = template('login.html')
const PICKER_HTML = template('picker.html')
const STATIC = {
  '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/static/app.css': ['app.css', 'text/css; charset=utf-8'],
}

function themeVars(p) {
  const [accent, userBg] = ACCENTS[p.accent]
  const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)).join(',')
  return `--accent:${accent};--accent-rgb:${rgb};--user-bg:${userBg};`
}
function fill(html, p, extra = {}) {
  const vars = {
    APP_NAME: esc(config.appName),
    PROFILE_ID: esc(p.id),
    PROFILE_NAME: esc(p.name),
    THEME: themeVars(p),
    ACCENT: ACCENTS[p.accent][0],
    ...extra,
  }
  return html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))
}

function avatarPath(p) {
  const exts = ['png', 'jpg', 'jpeg', 'webp']
  for (const f of [
    ...exts.map((e) => path.join(DATA, 'avatars', `${p.id}.${e}`)),
    ...exts.map((e) => path.join(DATA, `avatar.${e}`)),
  ]) {
    if (fs.existsSync(f)) return f
  }
  return null
}
function serveFile(res, file, type, cache = 'public, max-age=3600') {
  try {
    const body = fs.readFileSync(file)
    send(res, 200, body, { 'Content-Type': type, 'Cache-Control': cache })
  } catch {
    send(res, 404, 'Not found')
  }
}
const imgType = (f) => (f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg')

function readForm(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'

async function handleLogin(req, res, p) {
  const ip = clientIp(req)
  const lk = `${p.id}|${ip}`
  const l = lockouts.get(lk) ?? { fails: 0, until: 0, strikes: 0 }
  const page = (msg) =>
    send(res, 200, fill(LOGIN_HTML, p, { MESSAGE: msg ? `<p class="err">${esc(msg)}</p>` : '' }), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  if (req.method !== 'POST') return page('')
  const pf = profileFails.get(p.id) ?? { times: [], until: 0 }
  const lockedUntil = Math.max(l.until, pf.until)
  if (lockedUntil > Date.now()) {
    return page(`Too many attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 60000)} min.`)
  }
  let pin = ''
  try {
    pin = (await readForm(req)).get('pin') || ''
  } catch {
    return send(res, 413, 'Too large')
  }
  if (pin && verifyPin(pin, p.pinHash)) {
    lockouts.delete(lk)
    const maxAge = config.rememberDays > 0 ? config.rememberDays * 86400 : 10 * 365 * 86400
    const cookie = `${cookieName(p.id)}=${encodeURIComponent(makeCookie(p))}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`
    return send(res, 303, '', { Location: `/u/${p.id}/`, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' })
  }
  const now = Date.now()
  pf.times = pf.times.filter((t) => now - t < PROFILE_WINDOW_MS)
  pf.times.push(now)
  if (pf.times.length >= PROFILE_MAX_FAILS) {
    pf.until = now + PROFILE_LOCK_MS
    pf.times = []
    log(`profile ${p.id}: too many wrong PINs from several addresses, locked for 15 min`)
  }
  profileFails.set(p.id, pf)
  l.fails += 1
  if (l.fails >= MAX_FAILS) {
    l.strikes += 1
    l.until = Date.now() + BASE_LOCK_MS * 2 ** (l.strikes - 1)
    l.fails = 0
  }
  lockouts.set(lk, l)
  return page(l.until > Date.now() ? 'Too many attempts. Try again later.' : 'Incorrect PIN.')
}

function sweepUploads() {
  let entries = []
  try {
    entries = fs.readdirSync(UPLOADS)
  } catch {
    return
  }
  for (const name of entries) {
    const dir = path.join(UPLOADS, name)
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8'))
      if (Date.now() - (meta.createdAt || 0) > UPLOAD_TTL) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > UPLOAD_TTL) fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}
sweepUploads()
setInterval(sweepUploads, 3600_000).unref()

function handleDownload(req, res, token, requested) {
  if (anyPin && !config.profiles.some((p) => authorized(req, p))) return send(res, 403, 'Forbidden')
  const dir = path.join(UPLOADS, token)
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8'))
  } catch {
    return send(res, 404, 'Not found')
  }
  if (Date.now() - (meta.createdAt || 0) > UPLOAD_TTL) {
    fs.rmSync(dir, { recursive: true, force: true })
    return send(res, 410, 'Expired')
  }
  if (requested !== meta.filename) return send(res, 404, 'Not found')
  const file = path.join(dir, meta.filename)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return send(res, 404, 'Not found')
  }
  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': meta.mimeType || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${meta.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    'Cache-Control': 'private, no-store',
  })
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://x')
  } catch {
    return send(res, 400, 'Bad request')
  }
  const pathname = url.pathname
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return send(res, 405, 'Method not allowed')

  if (pathname === '/healthz') {
    return send(res, gwConnected ? 200 : 503, gwConnected ? 'ok' : 'gateway disconnected', { 'Content-Type': 'text/plain' })
  }
  if (pathname === '/favicon.ico') return serveFile(res, path.join(ASSETS, 'default-avatar.jpg'), 'image/jpeg')
  if (STATIC[pathname]) {
    const [f, type] = STATIC[pathname]
    return serveFile(res, path.join(UI, f), type, 'no-cache')
  }
  if (pathname === '/') {
    if (config.profiles.length === 1) return send(res, 302, '', { Location: `/u/${config.profiles[0].id}/` })
    const items = config.profiles
      .map(
        (p) =>
          `<a class="pick" href="/u/${esc(p.id)}/" style="--accent:${ACCENTS[p.accent][0]}"><img src="/u/${esc(p.id)}/avatar" alt=""><span>${esc(p.name)}</span></a>`,
      )
      .join('')
    return send(res, 200, PICKER_HTML.replaceAll('{{APP_NAME}}', esc(config.appName)).replaceAll('{{ITEMS}}', items), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  }
  const dl = pathname.match(/^\/download\/([a-f0-9]{32})\/([^/]+)$/)
  if (dl) {
    let name
    try {
      name = decodeURIComponent(dl[2])
    } catch {
      return send(res, 400, 'Bad request')
    }
    return handleDownload(req, res, dl[1], name)
  }

  const m = pathname.match(/^\/u\/([a-z][a-z0-9-]{0,23})(\/.*)?$/)
  if (!m) return send(res, 404, 'Not found')
  const p = profilesById.get(m[1])
  if (!p) return send(res, 404, 'Not found')
  const sub = m[2] || ''
  if (sub === '') return send(res, 301, '', { Location: `/u/${p.id}/` })

  // Assets that must work before login (login page, home-screen icon).
  if (sub === '/avatar' || sub === '/icon-180.png' || sub === '/icon-192.png' || sub === '/icon-512.png') {
    const custom = avatarPath(p)
    if (custom) return serveFile(res, custom, imgType(custom))
    if (sub === '/avatar') return serveFile(res, path.join(ASSETS, 'default-avatar.jpg'), 'image/jpeg')
    return serveFile(res, path.join(ASSETS, `default-${sub.slice(1)}`), 'image/png')
  }
  if (sub === '/manifest.webmanifest') {
    const custom = avatarPath(p)
    const icons = custom
      ? [{ src: `/u/${p.id}/icon-512.png`, sizes: 'any', type: imgType(custom) }]
      : [
          { src: `/u/${p.id}/icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `/u/${p.id}/icon-512.png`, sizes: '512x512', type: 'image/png' },
        ]
    const manifest = {
      id: `/u/${p.id}/`,
      name: config.profiles.length > 1 ? `${config.appName} — ${p.name}` : config.appName,
      short_name: config.appName,
      start_url: `/u/${p.id}/`,
      scope: `/u/${p.id}/`,
      display: 'standalone',
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
      icons,
    }
    return send(res, 200, JSON.stringify(manifest), { 'Content-Type': 'application/manifest+json' })
  }
  if (sub === '/login') {
    if (!p.pinHash) return send(res, 302, '', { Location: `/u/${p.id}/` })
    return handleLogin(req, res, p)
  }
  if (sub === '/logout' && req.method === 'POST') {
    return send(res, 303, '', {
      Location: `/u/${p.id}/`,
      'Set-Cookie': `${cookieName(p.id)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
    })
  }
  if (!authorized(req, p)) return send(res, 302, '', { Location: `/u/${p.id}/login`, 'Cache-Control': 'no-store' })
  if (sub === '/') {
    return send(res, 200, fill(APP_HTML, p, { HAS_PIN: p.pinHash ? 'true' : 'false' }), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  }
  return send(res, 404, 'Not found')
})

server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url, 'http://x')
  } catch {
    return socket.destroy()
  }
  const m = url.pathname.match(/^\/u\/([a-z][a-z0-9-]{0,23})\/ws$/)
  const p = m && profilesById.get(m[1])
  // Same-origin only: a page on another site can't open a socket with the
  // user's cookie.
  const origin = req.headers.origin
  let sameOrigin = false
  try {
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')]
      .map((h) => String(h || '').trim().toLowerCase())
      .filter(Boolean)
    sameOrigin = !origin || hosts.includes(new URL(origin).host.toLowerCase())
  } catch {}
  if (!sameOrigin) log(`refused websocket from origin ${origin} (host ${req.headers.host})`)
  if (!p || !sameOrigin || !authorized(req, p)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, p))
})

server.listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT}`))

// ── HTTP: loopback upload port (agent → user file hand-off) ─────────────────
function sanitizeFilename(name) {
  if (typeof name !== 'string' || !name) return null
  const base = name.replace(/\\/g, '/').split('/').pop()
  const cleaned = base.replace(/[^A-Za-z0-9._() -]+/g, '_').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.') || cleaned.length > 200) return null
  return cleaned
}
const uploadServer = http.createServer((req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.url === '/healthz') return json(200, { ok: true })
  if (req.url !== '/upload' || req.method !== 'POST') return json(404, { ok: false, error: 'not found' })
  let size = 0
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > UPLOAD_MAX * 1.4 + 4096) {
      json(413, { ok: false, error: 'payload too large' })
      req.destroy()
    } else chunks.push(c)
  })
  req.on('end', () => {
    if (res.writableEnded) return
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' })
    }
    const filename = sanitizeFilename(body.filename)
    if (!filename) return json(400, { ok: false, error: 'invalid filename' })
    if (typeof body.content !== 'string' || !body.content) return json(400, { ok: false, error: 'missing base64 content' })
    const bytes = Buffer.from(body.content, 'base64')
    if (!bytes.length) return json(400, { ok: false, error: 'empty file' })
    if (bytes.length > UPLOAD_MAX) return json(413, { ok: false, error: 'file too large' })
    const mimeType =
      typeof body.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mimeType) ? body.mimeType : 'application/octet-stream'
    const token = crypto.randomBytes(16).toString('hex')
    const dir = path.join(UPLOADS, token)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, filename), bytes, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ filename, mimeType, size: bytes.length, createdAt: Date.now() }))
    json(200, {
      ok: true,
      token,
      filename,
      mimeType,
      size: bytes.length,
      downloadUrl: `/download/${token}/${encodeURIComponent(filename)}`,
      marker: `[DOWNLOAD:${token}:${filename}:${mimeType}]`,
      expiresAt: Date.now() + UPLOAD_TTL,
    })
  })
})
uploadServer.listen(UPLOAD_PORT, '127.0.0.1', () => log(`upload endpoint on 127.0.0.1:${UPLOAD_PORT}`))

const shutdown = () => {
  log('shutting down')
  server.close()
  uploadServer.close()
  gw.stop()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
