// TAPEWARD server: API + round engine (+ static web/ when SERVE_WEB=1). Node ≥ 22.13, no framework.
// Env: PORT (4884 production, 4931 local) · BIND · DATA_DIR · DB=memory · TRUST_PROXY=1 · SERVE_WEB=1 · PUBLIC_URL
//      CHAIN_MODE=mock|chain · RACEBOOK=0x… · POSTER_PK (or /etc/tapeward/poster.env) · DESK_PK (optional, else poster key)
//      PRIZE_PK (or /etc/tapeward/prize.env) · LOG_RPC_URLS (top-up logs; default the official RC RPC)
//      KALSHI=live|fixtures|off · RPC_URL / RPC_URLS · TOKEN_JSON · RULES_JSON · FEEDS_JSON · FAKE_NOW / TIME_SCALE · NO_NETWORK=1
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { createTapeward } from './app.mjs'

const PORT = Number(process.env.PORT || 4884)
const WEB = fileURLToPath(new URL('../web/', import.meta.url))
const app = createTapeward()

export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.wasm': 'application/wasm', '.mp4': 'video/mp4' }
const notFound = async (res) => {
  try { const page = await readFile(join(WEB, '404.html')); res.writeHead(404, { 'content-type': MIME['.html'] }); return res.end(page) } catch {}
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}')
}

const server = createServer(async (req, res) => {
  try {
    if (await app.api(req, res)) return
    if (process.env.SERVE_WEB === '1' && (req.method === 'GET' || req.method === 'HEAD')) {
      const p = new URL(req.url, 'http://x').pathname
      let f = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '')
      if (/(^|\/)\./.test(f)) return notFound(res)
      if (f.endsWith('/')) f += 'index.html'
      let full = join(WEB, f)
      if (!full.startsWith(WEB)) return notFound(res)
      try { if ((await stat(full)).isDirectory()) full = join(full, 'index.html') } catch {
        if (!extname(full)) { try { await stat(full + '.html'); full += '.html' } catch {} }
      }
      const data = await readFile(full)
      res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      return res.end(req.method === 'HEAD' ? undefined : data)
    }
    notFound(res)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return notFound(res)
    console.error(req.url, e)
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"server error"}') }
  }
})
server.listen(PORT, process.env.BIND || undefined, async () => {
  const b = app.book
  console.log(`tapeward api on :${PORT} · chain ${b.mode}${b.address() ? ' ' + b.address() : ''} · ${b.canSend() ? 'can send' : 'cannot send: ' + b.why()} · kalshi ${app.kalshi?.status().mode ?? 'off'} · prizes ${app.prizes ? (app.prizes.overview().payer.canPay ? 'can pay' : 'no PRIZE_PK (planned, not paid)') : 'off'}${app.clock.fake ? ` · clock ${new Date(app.clock()).toISOString()} ×${app.clock.scale}` : ''}${process.env.SERVE_WEB === '1' ? ' · serving web/' : ''}`)
  await app.start()
})
const stop = () => { app.stop(); server.close(); try { app.store.close() } catch {} process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
