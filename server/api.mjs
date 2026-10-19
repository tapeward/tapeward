// HTTP API (no framework, JSON, CORS *). createApi(ctx) → async (req, res) → true when handled.
//   GET  /api/health                      { ok, mode, chainMode, rpc, feeds, kalshi, book, clock }
//   GET  /api/state                       broadcast state (fixtures/state.json)
//   GET  /api/round/:id                   meta + anchors (tx) + results (tx) + start/end Chainlink rounds
//   GET  /api/round/:id/picks[?n=]        leaves + proofs of anchor n (default last); sealed (hashes only) before picks close
//   GET  /api/board?round=&index=         ranks (best slot per wallet); official once settled, else live/unofficial
//   GET  /api/wallet/:addr                picks, receipts (anchored in root #n), scores, slots, holder status
//   GET  /api/race?since=lock|session     live race + 5-minute series (unofficial)
//   POST /api/pick                        { pick, signature[, address] }
//   POST /api/desk                        { address, name, signedAt, signature } (personal_sign of deskMessage)
//   GET  /api/proof                       contract, poster, feeds, every openRound / anchor / settle / snapshot tx
//   GET  /api/snapshot/:hash|latest       exact canonical Kalshi snapshot bytes (sha256 = hash)
//   GET  /api/card/:round/:addr.png       share card 1200×630 (always 200: generic without a pick; side/spread hidden while sealed)
//   GET  /api/stream                      SSE: state (15 s + on change) · pick · anchor · settled · snapshot
//   GET  /r/:round/:addr                  share page: web/r/index.html with OG/Twitter tags pointing at the card
import { readFile } from 'node:fs/promises'
import { getAddress } from 'viem'
import { iso, isZero, ROOT, token as tokenOf, appName, publicUrl } from './config.mjs'
import { renderCard, callWords } from './card.mjs'

const json = (res, code, body, extra = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...extra })
  res.end(JSON.stringify(body))
}
async function readBody(req, max = 4_000) {
  let n = 0; const chunks = []
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('bad json'), { status: 400 }) }
}
const ID = '([A-Z0-9-]{3,31})'
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export function createApi(ctx) {
  const { store, views, picks, kalshi, oracle, book, clock, bus, chain, prizes, token = tokenOf } = ctx
  const trustProxy = ctx.trustProxy ?? process.env.TRUST_PROXY === '1'
  const ipOf = (req) => (trustProxy && (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket?.remoteAddress || '?'

  function health() {
    const o = oracle.status()
    return {
      ok: true, name: appName(), mode: isZero(token().ca) ? 'preview' : 'live', now: iso(clock()),
      chainMode: book.mode, book: { racebook: book.address(), canSend: book.canSend(), why: book.why(), poster: book.posterAddress() },
      rpc: { ok: o.ok !== false && !chain?.status?.error, url: chain?.status?.url || null, error: o.error || chain?.status?.error || null, lastOkAt: chain?.status?.at ? iso(chain.status.at) : null },
      feeds: { lastPoll: iso(o.at), count: o.feeds ?? null },
      kalshi: kalshi ? (({ mode, ok, at, error, events, known }) => ({ mode, ok, at: iso(at), error, events, known }))(kalshi.status()) : null,
      rounds: store.rounds().length, clock: { fake: !!clock.fake, scale: clock.scale || 1 },
    }
  }

  /** view model of the share card (null when the wallet has no pick in the round) */
  /** "13:28 UTC" on the same UTC day, else "Tue 3 Nov 20:58 UTC" */
  const hhmm = (ms) => {
    const d = new Date(ms), t = d.toISOString().slice(11, 16) + ' UTC'
    return d.toISOString().slice(0, 10) === new Date(clock()).toISOString().slice(0, 10) ? t : `${d.toUTCString().slice(0, 3)} ${d.getUTCDate()} ${d.toUTCString().slice(8, 11)} ${t}`
  }
  const labelOf = (r) => (r.kind === 'election' ? `${r.label.toUpperCase()} · ${r.scoreLabels[0].toUpperCase()}` : r.label.toUpperCase())
  /** view model of the share card. Never null: no round / no pick → generic card; picks still sealed → no side/spread */
  async function cardModel(id, addr) {
    const r = store.getRound(id)
    const a = getAddress(addr)
    const base = { name: appName(), domain: token().domain, address: a }
    if (!r) return { ...base, generic: true, roundLabel: '' }
    const ps = store.picksOfPicker(a).filter((p) => p.round === id && !p.void)
    if (!ps.length) return { ...base, generic: true, roundLabel: labelOf(r) }
    const sealed = clock() < r.picksClose
    const b = sealed ? null : await views.board(id).catch(() => null)
    const row = b?.rows?.find((x) => x.address === a)
    const p = row ? ps.find((x) => x.slot === row.slot) || ps[0] : ps[0]
    const anc = store.anchorsOf(id).find((x) => (x.status === 'confirmed' || x.status === 'mock') && x.leaves.includes(p.leaf))
    const desk = row?.desk || store.desks().get(a.toLowerCase()) || null
    const signedAt = iso(p.signedAt * 1000).slice(0, 16).replace('T', ' ') + ' UTC'
    if (sealed) return { ...base, sealed: true, sealedUntil: hhmm(r.picksClose), roundLabel: labelOf(r), desk, signedAt, anchor: anc ? { n: anc.n, tx: anc.tx } : null, score: null, actual: null, live: null }
    const won = prizes ? prizes.wonBy(a).find((x) => x.round === id && (x.status === 'confirmed' || x.status === 'mock')) : null
    return {
      ...base,
      won: won ? { usd: won.usd, symbol: won.symbol, tx: won.tx } : null,
      anchor: anc ? { n: anc.n, tx: anc.tx } : null, settleTx: b?.official ? b.result?.tx ?? null : null,
      roundLabel: labelOf(r), desk, side: p.side === 1 ? 'BLUE' : 'RED', spreadBp: p.spreadBp, signedAt,
      score: b?.official && row ? row.score : null, rank: b?.official && row ? row.rank : null, of: b?.count ?? null,
      actual: b?.official ? b.result : null, live: !b?.official && b?.result ? b.result : null,
    }
  }
  async function card(id, addr) { return renderCard(await cardModel(id, addr)) }

  async function sharePage(res, id, addr) {
    const r = store.getRound(id)
    const a = getAddress(addr)
    const p = store.picksOfPicker(a).find((x) => x.round === id)
    let html
    try { html = await readFile(ROOT + 'web/r/index.html', 'utf8') } catch { html = '<!doctype html><html><head><meta charset="utf-8"><title>TAPEWARD</title></head><body><a href="/">TAPEWARD</a></body></html>' }
    const base = publicUrl()
    const title = `${appName()} · ${r ? r.label : id}`
    const who = `${a.slice(0, 6)}…${a.slice(-4)}`
    const desc = !p || !r ? 'Don\'t call the winner. Call the market.'
      : clock() < r.picksClose ? `${who} made a call for ${r.label} · sealed until ${hhmm(r.picksClose)} · free signed pick, recorded on Robinhood Chain.`
      : `${who} called: ${callWords(p.side === 1 ? 'BLUE' : 'RED', p.spreadBp)}. Free signed pick, recorded on Robinhood Chain.`
    const img = `${base}/api/card/${id}/${a}.png`
    const meta = [
      ['property', 'og:title', title], ['property', 'og:description', desc], ['property', 'og:image', img], ['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630'],
      ['property', 'og:url', `${base}/r/${id}/${a}`], ['property', 'og:type', 'website'], ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', title],
      ['name', 'twitter:description', desc], ['name', 'twitter:image', img],
    ]
    // drop the page's own og:/twitter: tags, then inject ours right after <head>
    html = html.replace(/<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>\s*/gi, '')
    const tags = meta.map(([k, n, v]) => `<meta ${k}="${n}" content="${escAttr(v)}">`).join('\n') + `\n<meta name="tapeward:round" content="${escAttr(id)}">\n<meta name="tapeward:address" content="${a}">\n`
    html = /<!--\s*og\s*-->/i.test(html) ? html.replace(/<!--\s*og\s*-->/i, tags) : html.replace(/<head[^>]*>/i, (m) => `${m}\n${tags}`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(html)
  }

  // ───────────────────────────── SSE
  const clients = new Set()
  const send = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }
  const broadcast = (event, data) => { for (const c of clients) send(c, event, data) }
  let pushTimer = null
  const pushState = () => {
    if (!clients.size || pushTimer) return
    pushTimer = setTimeout(async () => { pushTimer = null; try { broadcast('state', await views.state()) } catch {} }, 1500)
    pushTimer.unref?.()
  }
  if (bus) {
    bus.on('pick', (p) => { broadcast('pick', { round: p.round, replaced: p.replaced, counts: store.pickCount(p.round) }); pushState() })
    bus.on('anchor', (a) => { broadcast('anchor', a); pushState() })
    bus.on('settled', (s) => { broadcast('settled', s); pushState() })
    bus.on('snapshot', (s) => broadcast('snapshot', s))
    bus.on('kalshi', () => pushState())
    bus.on('prices', () => pushState())
    bus.on('round', () => pushState())
  }
  const beat = setInterval(async () => { if (!clients.size) return; for (const c of clients) { try { c.write(': ping\n\n') } catch {} } try { broadcast('state', await views.state()) } catch {} }, 15_000)
  beat.unref?.()

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    let m
    if ((m = new RegExp(`^/r/${ID}/(0x[0-9a-fA-F]{40})/?$`).exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) { await sharePage(res, m[1], m[2]); return true }
    if (!p.startsWith('/api/')) return false
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); res.end(); return true }
      if (req.method === 'POST' && p === '/api/pick') {
        const r = await picks.submit(await readBody(req), { ip: ipOf(req) })
        if (r.ok) {
          const rd = store.getRound(r.pick.round)
          r.nextAnchorAt = rd ? views.summary(rd).anchors.nextAt : null
          r.receipt = `/api/wallet/${r.pick.picker}`
        }
        return json(res, r.ok ? 200 : r.reason === 'rate_limited' ? 429 : 400, r), true
      }
      if (req.method === 'POST' && p === '/api/desk') { const r = await picks.setDesk(await readBody(req)); return json(res, r.ok ? 200 : 400, r), true }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }), true
      if (p === '/api/health') return json(res, 200, health()), true
      if (p === '/api/state') return json(res, 200, await views.state()), true
      if (p === '/api/proof') return json(res, 200, await views.proof()), true
      if (p === '/api/prizes') return json(res, prizes ? 200 : 404, prizes ? prizes.overview() : { error: 'prizes off' }), true
      if (p === '/api/board') {
        const id = url.searchParams.get('round') || views && (await views.state()).rounds.find((x) => x.role === 'current')?.id
        const b = id ? await views.board(id, url.searchParams.get('index')) : null
        return json(res, b ? 200 : 404, b || { error: 'no such round' }), true
      }
      if (p === '/api/race') {
        const since = url.searchParams.get('since')
        const st = await views.raceNow()
        let start = st ? Date.parse(st.since) : null
        if (since && /^\d{4}-\d{2}-\d{2}T/.test(since)) start = Date.parse(since)
        const series = start ? await oracle.series(start, clock(), Number(url.searchParams.get('step')) || 5) : []
        return json(res, 200, { race: st, election: await views.raceElection(), series, note: 'live, unofficial' }), true
      }
      if ((m = new RegExp(`^/api/round/${ID}/picks$`).exec(p))) { const d = views.picksDoc(m[1], url.searchParams.get('n')); return json(res, d ? 200 : 404, d || { error: 'no such round' }), true }
      if ((m = new RegExp(`^/api/round/${ID}$`).exec(p))) { const d = await views.round(m[1]); return json(res, d ? 200 : 404, d || { error: 'no such round' }), true }
      if ((m = /^\/api\/wallet\/(0x[0-9a-fA-F]{40})$/.exec(p))) return json(res, 200, await views.wallet(m[1])), true
      if (p.startsWith('/api/wallet/')) return json(res, 400, { error: 'not a wallet address' }), true
      if ((m = /^\/api\/snapshot\/(0x[0-9a-f]{64}|latest)$/.exec(p))) {
        const row = m[1] === 'latest' ? (store.lastSnapshot() && store.getSnapshot(store.lastSnapshot().hash)) : store.getSnapshot(m[1])
        const cur = !row && m[1] !== 'latest' && kalshi?.current()?.hash === m[1] ? kalshi.current() : null
        const body = row?.json || cur?.json
        if (!body) return json(res, 404, { error: 'no such snapshot' }), true
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*', 'x-sha256': row?.hash || cur.hash })
        res.end(body); return true
      }
      if ((m = new RegExp(`^/api/card/${ID}/(0x[0-9a-fA-F]{40})\\.png$`).exec(p))) {
        const c = await card(m[1], m[2])   // always an image: generic card for no pick, sealed card while picks are sealed
        res.writeHead(200, { 'content-type': c.type, 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' })
        res.end(c.body); return true
      }
      if (p === '/api/stream') {
        if (clients.size >= 5000) return json(res, 503, { error: 'busy' }), true
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' })
        res.write('retry: 5000\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        send(res, 'state', await views.state())
        return true
      }
      json(res, 404, { error: 'not found' })
      return true
    } catch (e) {
      if (e.status) { json(res, e.status, { error: e.message }); return true }
      console.error(req.method, p, e)
      if (!res.headersSent) json(res, 500, { error: 'server error' })
      return true
    }
  }
  handle.health = health
  handle.cardModel = cardModel
  handle.clients = clients
  handle.close = () => { clearInterval(beat); for (const c of clients) try { c.end() } catch {} }
  return handle
}
