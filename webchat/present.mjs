#!/usr/bin/env node
// Hand a file to the webchat user as a download card.
// Usage: node /opt/webchat/present.mjs <file> [mime-type] [display-name]
// Prints a [DOWNLOAD:...] marker; put it on its own line in your reply.
import fs from 'node:fs'
import path from 'node:path'

const [file, mimeArg, nameArg] = process.argv.slice(2)
const url = process.env.WEBCHAT_UPLOAD_URL || 'http://127.0.0.1:18801'
if (!file) {
  console.error('usage: present.mjs <file> [mime-type] [display-name]')
  process.exit(2)
}
const MIME = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
let bytes
try {
  bytes = fs.readFileSync(file)
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`)
  process.exit(1)
}
const filename = nameArg || path.basename(file)
const mimeType = mimeArg || MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream'
const res = await fetch(`${url}/upload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ filename, mimeType, content: bytes.toString('base64') }),
}).catch((e) => {
  console.error(`webchat upload endpoint unreachable at ${url}: ${e.message}`)
  process.exit(1)
})
const out = await res.json().catch(() => ({}))
if (!res.ok || !out.ok) {
  console.error(`upload failed: ${out.error || res.status}`)
  process.exit(1)
}
console.log(out.marker)
