// Mail server autodiscovery (since 2026.10.1:35): the IMAP and SMTP servers
// for an address, found the way Thunderbird finds them.
//
// Order: the provider's own settings file (autoconfig.<domain>, then
// <domain>/.well-known), Thunderbird's provider directory (ISPDB), the
// directory entry of the domain's mail server (MX, for a custom domain at a
// hosted provider), then DNS SRV records (RFC 6186). HTTPS only (a settings
// file over plain HTTP could point the password at anyone). Only encrypted
// servers with password login are taken; a provider that needs a sign-in
// instead (Microsoft) is named, not tried; Google is handed to the Gmail
// choice. The password is never part of the lookup.
//
// No StartOS imports: fetch and DNS can be replaced for tests (Io).

import { promises as dnsPromises } from 'node:dns'

export type Security = 'tls' | 'starttls'
export type Server = { host: string; port: number; security: Security }
export type Found = {
  kind: 'found'
  imap: Server
  smtp: Server
  /** Login name when it is not the address itself. */
  username?: string
  provider: string
  source: string
}
export type Discovery =
  | Found
  | { kind: 'gmail'; source: string }
  | { kind: 'signInOnly'; provider: string; source: string }
  | { kind: 'notFound'; tried: string[] }

export type Io = {
  getText: (url: string) => Promise<string | null>
  mx: (domain: string) => Promise<string[]>
  srv: (name: string) => Promise<{ name: string; port: number }[]>
}

const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 256 * 1024
export const ISPDB = 'https://autoconfig.thunderbird.net/v1.1/'

const GOOGLE_DOMAINS = ['gmail.com', 'googlemail.com', 'google.com']
const MICROSOFT_DOMAINS =
  /^(outlook|hotmail|live|msn|passport|windowslive)\.[a-z.]+$/

/** The real network: HTTPS GETs (final address must still be https), DNS. */
export const netIo: Io = {
  async getText(url) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/xml, text/xml' },
      })
      if (!res.ok || !res.url.startsWith('https://')) return null
      const text = await res.text()
      return text.length > MAX_BYTES ? null : text
    } catch {
      return null
    }
  },
  async mx(domain) {
    try {
      const rows = await dnsPromises.resolveMx(domain)
      return rows
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
    } catch {
      return []
    }
  },
  async srv(name) {
    try {
      const rows = await dnsPromises.resolveSrv(name)
      return rows
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
        .map((r) => ({
          name: r.name.toLowerCase().replace(/\.$/, ''),
          port: r.port,
        }))
    } catch {
      return []
    }
  },
}

/** Organisational domain, roughly (as mail/message.py's _org). */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean)
  if (
    parts.length >= 3 &&
    parts[parts.length - 1].length === 2 &&
    ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(
      parts[parts.length - 2],
    )
  )
    return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function tag(block: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) out.push(decode(m[1].trim()))
  return out
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

type Candidate = Server & { auth: string[]; username: string }

function servers(xml: string, which: 'incomingServer' | 'outgoingServer') {
  const want = which === 'incomingServer' ? 'imap' : 'smtp'
  const re = new RegExp(
    `<${which}\\s[^>]*type\\s*=\\s*["']([a-z0-9]+)["'][^>]*>([\\s\\S]*?)</${which}>`,
    'gi',
  )
  const out: (Candidate & { socket: string })[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[1].toLowerCase() !== want) continue
    const b = m[2]
    out.push({
      host: tag(b, 'hostname')[0] ?? '',
      port: Number(tag(b, 'port')[0] ?? 0),
      socket: (tag(b, 'socketType')[0] ?? '').toUpperCase(),
      security: 'tls',
      auth: tag(b, 'authentication').map((a) => a.toLowerCase()),
      username: tag(b, 'username')[0] ?? '',
    })
  }
  return out
}

/** Read a Thunderbird config-v1.1 file for an address. */
export function parseConfig(
  xml: string,
  address: string,
  source: string,
): Discovery | null {
  if (!/<clientConfig[\s>]/i.test(xml)) return null
  const [local, domain] = splitAddress(address)
  const fill = (s: string) =>
    s
      .replace(/%EMAILADDRESS%/g, address)
      .replace(/%EMAILLOCALPART%/g, local)
      .replace(/%EMAILDOMAIN%/g, domain)
  const provider =
    tag(xml, 'displayName')[0] || tag(xml, 'displayShortName')[0] || domain

  const pick = (list: ReturnType<typeof servers>, smtp: boolean) => {
    const usable: (Candidate & { rank: number })[] = []
    let signInOnly = false
    for (const s of list) {
      const host = fill(s.host).toLowerCase()
      if (!HOST_RE.test(host) || !(s.port > 0 && s.port < 65536)) continue
      if (s.socket !== 'SSL' && s.socket !== 'STARTTLS') continue // never plain text
      // The mail service logs in with LOGIN/PLAIN (always inside TLS);
      // "password-encrypted" alone means CRAM-MD5, which it does not speak.
      const pw = s.auth.some((a) => a === 'password-cleartext' || a === 'plain')
      if (!pw) {
        if (s.auth.includes('oauth2')) signInOnly = true
        continue
      }
      const security: Security = s.socket === 'SSL' ? 'tls' : 'starttls'
      // SSL/TLS first; for SMTP, 465 before 587.
      const rank =
        (security === 'tls' ? 0 : 10) + (smtp && s.port === 465 ? 0 : 1)
      usable.push({ ...s, host, security, rank, username: fill(s.username) })
    }
    usable.sort((a, b) => a.rank - b.rank)
    return { best: usable[0], signInOnly }
  }
  const imap = pick(servers(xml, 'incomingServer'), false)
  const smtp = pick(servers(xml, 'outgoingServer'), true)

  if (
    servers(xml, 'incomingServer').some(
      (s) => baseDomain(fill(s.host)) === 'gmail.com',
    )
  )
    return { kind: 'gmail', source }
  if (!imap.best || !smtp.best) {
    if (imap.signInOnly || smtp.signInOnly)
      return { kind: 'signInOnly', provider, source }
    return null
  }
  const user = imap.best.username
  return {
    kind: 'found',
    imap: {
      host: imap.best.host,
      port: imap.best.port,
      security: imap.best.security,
    },
    smtp: {
      host: smtp.best.host,
      port: smtp.best.port,
      security: smtp.best.security,
    },
    ...(user && user.toLowerCase() !== address.toLowerCase()
      ? { username: user }
      : {}),
    provider,
    source,
  }
}

export function splitAddress(address: string): [string, string] {
  const a = address.trim()
  const at = a.lastIndexOf('@')
  return [
    a.slice(0, at),
    a
      .slice(at + 1)
      .toLowerCase()
      .replace(/\.$/, ''),
  ]
}

function microsoft(host: string) {
  const h = host.toLowerCase()
  return (
    MICROSOFT_DOMAINS.test(h) ||
    h.endsWith('.outlook.com') ||
    h.endsWith('.office365.com') ||
    h.endsWith('.protection.outlook.com')
  )
}

const MS = 'Microsoft (Outlook.com, Hotmail, Microsoft 365)'

/** Find the servers for an address. */
export async function discover(
  address: string,
  io: Io = netIo,
): Promise<Discovery> {
  const [, domain] = splitAddress(address)
  const tried: string[] = []
  if (!HOST_RE.test(domain)) return { kind: 'notFound', tried }
  if (GOOGLE_DOMAINS.includes(domain))
    return { kind: 'gmail', source: 'a Google address' }
  if (microsoft(domain))
    return { kind: 'signInOnly', provider: MS, source: 'a Microsoft address' }

  const fromUrl = async (url: string, label: string) => {
    tried.push(label)
    const xml = await io.getText(url)
    return xml ? parseConfig(xml, address, label) : null
  }
  const q = `?emailaddress=${encodeURIComponent(address)}`
  // Asked together (as Thunderbird does), taken in this order.
  const urls = [
    [
      `https://autoconfig.${domain}/mail/config-v1.1.xml${q}`,
      `the provider's settings file (autoconfig.${domain})`,
    ],
    [
      `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
      `the provider's settings file (${domain}/.well-known)`,
    ],
    [ISPDB + domain, `Thunderbird's provider directory (${domain})`],
  ] as const
  const [results, mx] = await Promise.all([
    Promise.all(urls.map(([url, label]) => fromUrl(url, label))),
    io.mx(domain),
  ])
  // A source that offers only a browser sign-in does not end the search
  // (since :36): Fastmail's own settings file now names OAuth2 only, while
  // its IMAP still takes app passwords and the directory lists them. Only
  // when nothing anywhere offers a password login is the sign-in reported.
  let signIn: Discovery | null = null
  const usable = (r: Discovery | null) => {
    if (r?.kind === 'signInOnly') {
      signIn ??= r
      return null
    }
    return r
  }
  for (const r of results) if (usable(r)) return r as Discovery

  // A custom domain at a hosted provider: its mail server's directory entry.
  tried.push(`the domain's mail server (MX)`)
  if (mx.length) {
    const top = mx[0]
    if (microsoft(top))
      return {
        kind: 'signInOnly',
        provider: MS,
        source: `the domain's mail server (${top})`,
      }
    const base = baseDomain(top)
    if (base === 'google.com' || base === 'googlemail.com')
      return { kind: 'gmail', source: `the domain's mail server (${top})` }
    if (base && base !== domain) {
      const r = await fromUrl(
        ISPDB + base,
        `Thunderbird's provider directory (${base}, the mail server of ${domain})`,
      )
      if (usable(r)) return r as Discovery
    }
  }

  // RFC 6186: _imaps/_imap and _submissions/_submission.
  tried.push('DNS SRV records')
  const first = async (
    name: string,
    security: Security,
  ): Promise<Server | null> => {
    const rows = (await io.srv(name)).filter(
      (r) => r.name && r.name !== '.' && HOST_RE.test(r.name) && r.port > 0,
    )
    return rows.length
      ? { host: rows[0].name, port: rows[0].port, security }
      : null
  }
  const imap =
    (await first(`_imaps._tcp.${domain}`, 'tls')) ??
    (await first(`_imap._tcp.${domain}`, 'starttls'))
  const smtp =
    (await first(`_submissions._tcp.${domain}`, 'tls')) ??
    (await first(`_submission._tcp.${domain}`, 'starttls'))
  if (imap && smtp)
    return {
      kind: 'found',
      imap,
      smtp,
      provider: domain,
      source: `DNS SRV records of ${domain}`,
    }
  return signIn ?? { kind: 'notFound', tried }
}

const SEC = { tls: 'SSL/TLS', starttls: 'STARTTLS' } as const

/** Lines for an action result. */
export function describe(d: Discovery, address: string): string {
  switch (d.kind) {
    case 'found':
      return [
        `Provider: ${d.provider}`,
        `Found in: ${d.source}`,
        `IMAP: ${d.imap.host}, port ${d.imap.port}, ${SEC[d.imap.security]}`,
        `SMTP: ${d.smtp.host}, port ${d.smtp.port}, ${SEC[d.smtp.security]}`,
        `Login name: ${d.username ?? `${address} (the address)`}`,
      ].join('\n')
    case 'gmail':
      return `This is a Google mailbox (${d.source}). Use the Gmail (app password) choice in Configure Email: it knows Google's servers and its sender check.`
    case 'signInOnly':
      return `${d.provider} (${d.source}) needs a sign-in in the browser (OAuth), not a password, for mail apps. That is not supported yet.`
    case 'notFound':
      return `No mail settings were found for ${splitAddress(address)[1]}.${d.tried.length ? ` Looked in: ${d.tried.join('; ')}.` : ''} Choose "Other IMAP/SMTP provider" and enter the servers your provider documents.`
  }
}
