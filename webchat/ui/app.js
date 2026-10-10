'use strict'
;(() => {
  const B = document.body.dataset
  const PROFILE = B.profile
  const DEFAULT_KEY = `agent:main:wc-${PROFILE}`
  const $ = (id) => document.getElementById(id)
  const els = {
    list: $('conv-list'),
    msgs: $('messages'),
    input: $('msg-input'),
    send: $('send-btn'),
    stop: $('stop-btn'),
    area: $('input-area'),
    label: $('conv-label'),
    dot: $('status-dot'),
    banner: $('banner'),
    sidebar: $('sidebar'),
    overlay: $('sidebar-overlay'),
  }
  if (B.hasPin === 'true') $('logout-form').hidden = false

  const store = {
    get(k) {
      try {
        return localStorage.getItem(`wc:${PROFILE}:${k}`)
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`wc:${PROFILE}:${k}`, v)
      } catch {}
    },
  }

  // ── Connection ────────────────────────────────────────────────────────────
  let ws = null
  let rid = 0
  let connected = false // gateway reachable
  let wsOpen = false
  let retry = 0
  const pending = new Map()

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/u/${PROFILE}/ws`)
    ws.onopen = () => {
      wsOpen = true
      retry = 0
    }
    ws.onmessage = (e) => {
      let m
      try {
        m = JSON.parse(e.data)
      } catch {
        return
      }
      if (m.type === 'res') {
        const p = pending.get(m.id)
        if (p) {
          pending.delete(m.id)
          m.ok ? p.resolve(m.payload) : p.reject(new Error(m.error || 'failed'))
        }
      } else if (m.type === 'status') {
        setConnected(m.connected)
      } else if (m.type === 'event' && m.event === 'chat') {
        onChatEvent(m)
      }
    }
    ws.onclose = () => {
      const wasOpen = wsOpen
      wsOpen = false
      setConnected(false)
      for (const p of pending.values()) p.reject(new Error('disconnected'))
      pending.clear()
      retry++
      // If the socket was refused outright, our sign-in may have expired.
      if (!wasOpen && retry >= 2) {
        fetch(location.pathname, { redirect: 'manual', cache: 'no-store' })
          .then((r) => {
            if (r.type === 'opaqueredirect' || r.status === 302) location.reload()
          })
          .catch(() => {})
      }
      setTimeout(connect, Math.min(1000 * 2 ** Math.min(retry, 4), 15000))
    }
  }

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error('Not connected'))
      const id = ++rid
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('timed out'))
        }
      }, 60000)
    })
  }

  let firstConnect = true
  function setConnected(v) {
    const changed = v !== connected
    connected = v
    els.dot.classList.toggle('off', !v)
    els.dot.title = v ? 'Connected' : 'Disconnected'
    els.banner.classList.toggle('show', !v && !firstConnect)
    updateSend()
    if (v && changed) {
      firstConnect = false
      refreshConvs().then(() => loadHistory())
    }
  }

  // ── Conversations ─────────────────────────────────────────────────────────
  let convs = [{ key: DEFAULT_KEY, name: 'General', fixed: true }]
  let current = store.get('current') || DEFAULT_KEY

  async function refreshConvs() {
    try {
      const res = await call('convs.list')
      convs = res.convs
    } catch {}
    if (!convs.some((c) => c.key === current)) current = convs[0].key
    renderConvs()
  }

  function convName(key) {
    return convs.find((c) => c.key === key)?.name || 'Conversation'
  }

  function renderConvs() {
    els.list.textContent = ''
    for (const c of convs) {
      const item = document.createElement('div')
      item.className = 'conv-item' + (c.key === current ? ' active' : '')
      item.dataset.key = c.key
      const name = document.createElement('span')
      name.className = 'conv-name'
      name.textContent = c.name
      name.title = c.name
      item.append(name)
      if (!c.general) item.append(iconBtn('✎', 'Rename', () => startRename(c, name)))
      item.append(iconBtn(c.fixed ? '⟲' : '×', c.fixed ? 'Clear' : 'Delete', () => removeConv(c)))
      item.addEventListener('click', () => switchConv(c.key))
      els.list.append(item)
    }
    els.label.textContent = convName(current)
  }
  function iconBtn(text, title, fn) {
    const b = document.createElement('button')
    b.className = 'icon-btn'
    b.type = 'button'
    b.textContent = text
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    return b
  }

  function switchConv(key) {
    if (isMobile()) closeSidebar()
    if (key === current) return
    current = key
    store.set('current', key)
    runs.clear()
    endPriming()
    setBusy(false)
    renderConvs()
    loadHistory()
  }

  function startRename(c, span) {
    const old = c.name
    span.contentEditable = 'true'
    span.focus()
    const r = document.createRange()
    r.selectNodeContents(span)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    const stop = (e) => e.stopPropagation()
    span.addEventListener('click', stop)
    const finish = async (save) => {
      span.contentEditable = 'false'
      span.removeEventListener('click', stop)
      const name = (span.textContent || '').trim()
      if (!save || !name || name === old) {
        span.textContent = old
        return
      }
      c.name = name
      els.label.textContent = convName(current)
      try {
        await call('convs.rename', { key: c.key, name })
      } catch (e) {
        c.name = old
        span.textContent = old
        toast(`Rename failed: ${e.message}`)
      }
    }
    span.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          span.blur()
        } else if (e.key === 'Escape') {
          span.textContent = old
          span.blur()
        }
      },
    )
    span.addEventListener('blur', () => finish(true), { once: true })
  }

  async function removeConv(c) {
    const ok = await dialog({
      title: c.fixed ? `Clear “${c.name}”? It starts over empty.` : `Delete “${c.name}”?`,
      okText: c.fixed ? 'Clear' : 'Delete',
    })
    if (!ok) return
    let res
    try {
      res = await call('convs.delete', { key: c.key })
    } catch (e) {
      return toast(`Failed: ${e.message}`)
    }
    const wasCurrent = current === c.key
    if (c.fixed && res.key) {
      c.key = res.key
      if (wasCurrent) current = res.key
    } else {
      convs = convs.filter((x) => x.key !== c.key)
      if (wasCurrent) current = convs[0].key
    }
    store.set('current', current)
    renderConvs()
    if (wasCurrent) loadHistory()
  }

  async function newConv() {
    const name = await dialog({ title: 'Name this conversation', input: true, okText: 'Create' })
    if (!name) return
    try {
      const c = await call('convs.create', { name })
      convs.splice(1 + convs.filter((x) => x.preset).length, 0, { key: c.key, name: c.name })
      switchConv(c.key)
    } catch (e) {
      toast(`Failed: ${e.message}`)
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  let busy = false
  let historySeq = 0

  async function loadHistory() {
    const seq = ++historySeq
    const key = current
    els.msgs.textContent = ''
    runs.clear()
    if (!connected) return showEmpty()
    let res
    try {
      res = await call('chat.history', { key })
    } catch (e) {
      if (seq === historySeq) toast(`Could not load messages: ${e.message}`)
      return
    }
    if (seq !== historySeq) return
    // Anything on screen now was added after this load started (e.g. a
    // message sent right after connecting): keep it, put history above it.
    clearEmpty()
    const live = [...els.msgs.childNodes]
    const sentMeanwhile = live.some((n) => n.classList?.contains('user'))
    const typing = typingEl
    els.msgs.textContent = ''
    for (const m of res.messages) addMsg(m.role, m.text, m.ts)
    els.msgs.append(...live)
    if (typing && live.includes(typing)) typingEl = typing // addMsg() cleared the reference
    if (!res.messages.length && !live.length) {
      showEmpty()
      if (res.empty && !sentMeanwhile) {
        call('chat.prime', { key })
          .then((r) => {
            if (r.primed && key === current) {
              showTyping()
              startPriming(key)
            }
          })
          .catch(() => {})
      }
    }
    scrollDown(true)
  }

  function showEmpty() {
    if (els.msgs.querySelector('.empty-state')) return
    const d = document.createElement('div')
    d.className = 'empty-state'
    const img = document.createElement('img')
    img.src = `/u/${PROFILE}/avatar`
    img.alt = ''
    const p = document.createElement('p')
    p.textContent = connected ? `Start a conversation with ${B.appName}.` : 'Connecting…'
    d.append(img, p)
    els.msgs.append(d)
  }
  function clearEmpty() {
    els.msgs.querySelector('.empty-state')?.remove()
  }

  function addMsg(role, text, ts, extraClass) {
    clearEmpty()
    removeTyping()
    const w = document.createElement('div')
    w.className = `msg ${role === 'user' ? 'user' : 'assistant'}${extraClass ? ' ' + extraClass : ''}`
    const b = document.createElement('div')
    b.className = 'msg-bubble'
    render(b, role, text)
    w.append(b)
    if (ts) {
      const t = document.createElement('span')
      t.className = 'msg-time'
      t.textContent = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      w.append(t)
    }
    els.msgs.append(w)
    return b
  }

  let typingEl = null
  function showTyping() {
    if (typingEl) return
    clearEmpty()
    typingEl = document.createElement('div')
    typingEl.className = 'msg assistant'
    const tb = document.createElement('div')
    tb.className = 'typing-bubble'
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div')
      d.className = 'typing-dot'
      tb.append(d)
    }
    typingEl.append(tb)
    els.msgs.append(typingEl)
    scrollDown()
  }
  function removeTyping() {
    typingEl?.remove()
    typingEl = null
  }

  // One entry per agent run, so overlapping replies (e.g. the topic greeting
  // and the person's first message) each keep their own bubble.
  const runs = new Map() // runId -> { text, bubble }
  let renderQueued = false
  function onChatEvent(m) {
    if (m.key !== current) return
    if (m.state === 'status') {
      setBusy(true)
      if (!runs.has(m.runId)) showTyping()
      return
    }
    if (m.state === 'delta') {
      setBusy(true)
      let r = runs.get(m.runId)
      if (!r) runs.set(m.runId, (r = { text: '', bubble: addMsg('assistant', '') }))
      r.text = m.replace ? m.deltaText : r.text + m.deltaText
      if (!renderQueued) {
        renderQueued = true
        requestAnimationFrame(() => {
          renderQueued = false
          for (const x of runs.values()) render(x.bubble, 'assistant', x.text)
          scrollDown()
        })
      }
      return
    }
    // terminal states
    const r = runs.get(m.runId)
    runs.delete(m.runId)
    if (m.state === 'final' || m.state === 'aborted') {
      const text = m.text || r?.text || ''
      if (r) render(r.bubble, 'assistant', text)
      else if (text) addMsg('assistant', text)
      if (m.state === 'aborted') addMsg('assistant', 'Stopped.', null, 'error')
    } else if (m.state === 'error') {
      if (r && !r.text) r.bubble.parentElement?.remove()
      addMsg('assistant', m.errorMessage || 'Something went wrong.', null, 'error')
    }
    if (primingKey === m.key) endPriming()
    if (!runs.size) {
      removeTyping()
      setBusy(false)
    }
    scrollDown()
  }

  // While the hidden topic greeting is being answered, hold the composer so
  // the person's first message lands after the agent's greeting.
  let primingKey = null
  let primingTimer = null
  function startPriming(key) {
    primingKey = key
    clearTimeout(primingTimer)
    primingTimer = setTimeout(endPriming, 45000)
    els.input.placeholder = `${B.appName} is getting ready…`
    updateSend()
  }
  function endPriming() {
    primingKey = null
    clearTimeout(primingTimer)
    els.input.placeholder = `Message ${B.appName}…`
    updateSend()
  }

  async function sendMessage() {
    const text = els.input.value
    if (!text.trim() || !connected || primingKey === current) return
    els.input.value = ''
    autosize()
    addMsg('user', text, Date.now())
    showTyping()
    setBusy(true)
    scrollDown(true)
    try {
      await call('chat.send', { key: current, text })
    } catch (e) {
      removeTyping()
      setBusy(false)
      addMsg('assistant', `Not sent: ${e.message}`, null, 'error')
    }
  }

  function setBusy(v) {
    busy = v
    els.area.classList.toggle('busy', v)
    updateSend()
  }
  function updateSend() {
    els.send.disabled = !connected || !els.input.value.trim() || primingKey === current
  }

  function scrollDown(force) {
    const m = els.msgs
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 160
    if (force || near) m.scrollTop = m.scrollHeight
  }

  // ── Rendering: download cards + light markdown ────────────────────────────
  const DL_RE = /\[DOWNLOAD:([a-f0-9]{32}):([^:\]]+):([^\]]+)\]/g

  function render(bubble, role, text) {
    bubble.textContent = ''
    if (role === 'user') {
      bubble.textContent = text
      return
    }
    bubble.classList.add('md')
    let last = 0
    DL_RE.lastIndex = 0
    let m
    while ((m = DL_RE.exec(text))) {
      appendMd(bubble, text.slice(last, m.index))
      bubble.append(dlCard(m[1], m[2], m[3]))
      last = m.index + m[0].length
    }
    appendMd(bubble, text.slice(last))
  }
  function appendMd(parent, src) {
    if (!src.trim()) return
    const div = document.createElement('div')
    div.innerHTML = markdown(src) // markdown() escapes all input first
    parent.append(...div.childNodes)
  }

  function dlCard(token, filename, mime) {
    const a = document.createElement('a')
    a.className = 'dl-card'
    a.href = `/download/${token}/${encodeURIComponent(filename)}`
    a.setAttribute('download', filename)
    a.rel = 'noopener'
    a.innerHTML =
      '<div class="dl-card-icon"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg></div><div class="dl-card-body"><div class="dl-card-name"></div><div class="dl-card-meta"></div></div><div class="dl-card-arrow"><svg viewBox="0 0 24 24"><path d="M12 4v12"/><polyline points="6 12 12 18 18 12"/></svg></div>'
    a.querySelector('.dl-card-name').textContent = filename
    a.querySelector('.dl-card-name').title = filename
    a.querySelector('.dl-card-meta').textContent = `${shortMime(mime)} · tap to download`
    return a
  }
  function shortMime(m) {
    m = (m || '').toLowerCase()
    const known = {
      'application/pdf': 'PDF',
      'text/plain': 'Text',
      'text/markdown': 'Markdown',
      'text/csv': 'CSV',
      'application/json': 'JSON',
      'application/zip': 'ZIP',
    }
    if (known[m]) return known[m]
    if (m.includes('wordprocessingml')) return 'DOCX'
    if (m.includes('spreadsheetml')) return 'XLSX'
    if (m.includes('presentationml')) return 'PPTX'
    if (/^(image|audio|video)\//.test(m)) return m.split('/')[1].toUpperCase()
    return (m.split('/').pop() || 'File').toUpperCase()
  }

  const escHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  function inline(s) {
    // s is already HTML-escaped. Protect code spans first.
    const codes = []
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c)
      return `\u0000${codes.length - 1}\u0000`
    })
    const stash = (html) => {
      codes.push({ html })
      return `\u0000${codes.length - 1}\u0000`
    }
    const link = (href, label) => stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    s = s
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g, (_, t, h) => link(h, t))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, (_, pre, h) => pre + link(h, h))
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const c = codes[+i]
      return typeof c === 'string' ? `<code>${c}</code>` : c.html
    })
  }

  function markdown(src) {
    const out = []
    // With the fence's info string captured, the parts repeat as
    // prose, opening info, code, closing info. An unclosed fence during
    // streaming stays code.
    const parts = src.split(/^```([^\n]*)\n?/m)
    for (let i = 0; i < parts.length; i += 4) {
      out.push(blocks(escHtml(parts[i])))
      if (i + 2 < parts.length) out.push(codeBlock(parts[i + 1], parts[i + 2]))
    }
    return out.join('')
  }

  const COPY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  function codeBlock(info, code) {
    const lang = (info.trim().split(/\s+/)[0] || '').replace(/[^\w+#.-]/g, '').slice(0, 24)
    return (
      '<div class="code-block"><div class="code-head">' +
      `<span class="code-lang">${escHtml(lang)}</span>` +
      `<button type="button" class="code-copy" title="Copy code" aria-label="Copy code">${COPY_ICON}<span>Copy</span></button>` +
      `</div><pre><code>${escHtml(code.replace(/\n$/, ''))}</code></pre></div>`
    )
  }

  // ── Copy code ─────────────────────────────────────────────────────────────
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {}
    // Plain-HTTP pages have no Clipboard API; fall back to a hidden textarea.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px'
    document.body.append(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {}
    ta.remove()
    return ok
  }
  els.msgs.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy')
    if (!btn) return
    const code = btn.closest('.code-block')?.querySelector('code')
    if (!code) return
    const ok = await copyText(code.textContent)
    const label = btn.querySelector('span')
    if (!label) return
    label.textContent = ok ? 'Copied' : 'Copy failed'
    btn.classList.toggle('done', ok)
    clearTimeout(btn._t)
    btn._t = setTimeout(() => {
      label.textContent = 'Copy'
      btn.classList.remove('done')
    }, 1600)
  })

  function blocks(s) {
    const lines = s.split('\n')
    const out = []
    let para = []
    let list = null // { type, items }
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`)
      para = []
    }
    const flushList = () => {
      if (list) out.push(`<${list.type}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.type}>`)
      list = null
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let m
      if (!line.trim()) {
        flushPara()
        flushList()
        continue
      }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara()
        flushList()
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`)
        continue
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara()
        flushList()
        out.push('<hr>')
        continue
      }
      if ((m = line.match(/^&gt;\s?(.*)$/))) {
        flushPara()
        flushList()
        out.push(`<blockquote>${inline(m[1])}</blockquote>`)
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
        flushPara()
        flushList()
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
        const head = row(line)
        i++
        const body = []
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) body.push(row(lines[++i]))
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        )
        continue
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const type = /^\s*\d/.test(line) ? 'ol' : 'ul'
        flushPara()
        if (!list || list.type !== type) {
          flushList()
          list = { type, items: [] }
        }
        list.items.push(m[1])
        continue
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim()
        continue
      }
      flushList()
      para.push(line)
    }
    flushPara()
    flushList()
    return out.join('')
  }

  // ── Dialog + toast ────────────────────────────────────────────────────────
  function dialog({ title, input = false, okText = 'OK' }) {
    return new Promise((resolve) => {
      const ov = $('dialog')
      const inp = $('dialog-input')
      $('dialog-title').textContent = title
      $('dialog-ok').textContent = okText
      inp.hidden = !input
      inp.value = ''
      ov.hidden = false
      setTimeout(() => (input ? inp.focus() : $('dialog-ok').focus()), 30)
      const done = (val) => {
        ov.hidden = true
        $('dialog-ok').onclick = $('dialog-cancel').onclick = inp.onkeydown = ov.onclick = null
        resolve(val)
      }
      $('dialog-ok').onclick = () => done(input ? inp.value.trim() : true)
      $('dialog-cancel').onclick = () => done(input ? '' : false)
      ov.onclick = (e) => e.target === ov && done(input ? '' : false)
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') done(inp.value.trim())
        if (e.key === 'Escape') done('')
      }
    })
  }
  function toast(text) {
    addMsg('assistant', text, null, 'error')
    scrollDown(true)
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const isMobile = () => matchMedia('(max-width: 640px)').matches
  function closeSidebar() {
    els.sidebar.classList.remove('mobile-open')
    els.overlay.classList.remove('visible')
  }
  $('menu-btn').addEventListener('click', () => {
    if (isMobile()) {
      const open = !els.sidebar.classList.contains('mobile-open')
      els.sidebar.classList.toggle('mobile-open', open)
      els.overlay.classList.toggle('visible', open)
    } else {
      const collapsed = els.sidebar.classList.toggle('collapsed')
      store.set('sidebar', collapsed ? '0' : '1')
    }
  })
  els.overlay.addEventListener('click', closeSidebar)
  if (store.get('sidebar') === '0' && !isMobile()) els.sidebar.classList.add('collapsed')
  $('new-btn').addEventListener('click', newConv)

  // ── Composer ──────────────────────────────────────────────────────────────
  function autosize() {
    els.input.style.height = 'auto'
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px'
    updateSend()
  }
  els.input.addEventListener('input', autosize)
  els.input.addEventListener('keydown', (e) => {
    const desktop = matchMedia('(pointer: fine)').matches
    if (e.key === 'Enter' && !e.shiftKey && desktop && !e.isComposing) {
      e.preventDefault()
      if (!busy) sendMessage()
    }
  })
  els.send.addEventListener('click', sendMessage)
  els.stop.addEventListener('click', () => call('chat.abort', { key: current }).catch(() => {}))

  renderConvs()
  showEmpty()
  connect()
})()
