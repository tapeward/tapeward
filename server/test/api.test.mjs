import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { makeApp, signPick, acct, nowS } from './helpers.mjs'

async function serve(app) {
  const srv = createServer(async (req, res) => { if (!(await app.api(req, res))) { res.writeHead(404); res.end() } })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  return { base, close: () => new Promise((r) => { app.stop(); srv.closeAllConnections?.(); srv.close(r) }) }
}

test('HTTP API: state, pick, picks (sealed/open), board, wallet, proof, snapshot, card, share page', async () => {
  const app = makeApp({ now: '2026-10-19T08:00:00Z' })
  await app.kalshi.poll()
  await app.rounds.tick()
  const { base, close } = await serve(app)
  try {
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) } }
    const health = await get('/api/health')
    assert.equal(health.body.ok, true); assert.equal(health.body.chainMode, 'mock'); assert.equal(health.headers.get('access-control-allow-origin'), '*')
    const st = await get('/api/state')
    for (const k of ['now', 'token', 'market', 'rounds', 'race', 'kalshi', 'desk', 'counts']) assert.ok(k in st.body, k)
    assert.deepEqual(st.body.rounds.map((r) => r.role), ['next', 'election'])
    assert.ok(st.body.race.red.feeds.length === 6 && st.body.race.blue.feeds.length === 6 && st.body.race.ref.feeds.length === 1)
    assert.equal(st.body.race.spreadBp, st.body.race.red.bp - st.body.race.blue.bp)
    assert.ok(st.body.kalshi.control.house.pD > 0)

    const u = acct(7)
    app.clock.set('2026-10-19T08:10:00Z')
    const body = await signPick(u, { round: 'D-2026-10-19', side: 1, spreadBp: -30, slot: 0, signedAt: nowS(app) })
    const r = await fetch(base + '/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, pick: { ...body.pick, side: 1 } }) })
    const pj = await r.json()
    assert.equal(r.status, 200, JSON.stringify(pj)); assert.equal(pj.ok, true); assert.equal(pj.pick.picker, u.address)
    assert.equal(pj.nextAnchorAt, '2026-10-19T09:00:00.000Z')
    const bad = await fetch(base + '/api/pick', { method: 'POST', body: '{"pick":{"round":"D-2026-10-19","side":0,"spreadBp":-5,"slot":0,"signedAt":1}}' })
    assert.equal(bad.status, 400); assert.equal((await bad.json()).reason, 'side_mismatch')

    app.clock.set('2026-10-19T09:00:02Z'); await app.rounds.tick()
    const sealed = await get('/api/round/D-2026-10-19/picks')
    assert.equal(sealed.body.sealed, true); assert.equal(sealed.body.count, 2); assert.ok(sealed.body.leaves[0].proof)
    const wallet = await get(`/api/wallet/${u.address}`)
    assert.equal(wallet.body.picks[0].status, 'anchored'); assert.equal(wallet.body.picks[0].anchored.n, 2)
    assert.equal((await get('/api/board?round=D-2026-10-19')).body.rows.length, 0)   // sealed

    app.clock.set('2026-10-19T13:28:30Z'); await app.rounds.tick()
    app.clock.set('2026-10-19T15:00:00Z')
    const open = await get('/api/round/D-2026-10-19/picks')
    assert.equal(open.body.sealed, false); assert.equal(open.body.leaves.find((l) => l.picker === u.address).spreadBp, -30)
    assert.ok(open.body.leaves.some((l) => l.desk === 'TAPEWARD desk'))
    const board = await get('/api/board?round=D-2026-10-19')
    assert.equal(board.body.official, false); assert.equal(board.body.rows.length, 2)
    const rd = await get('/api/round/D-2026-10-19')
    assert.equal(rd.body.anchors.length, 2); assert.equal(rd.body.status, 'live')
    const proof = await get('/api/proof')
    assert.ok(proof.body.events.some((e) => e.type === 'anchor') && proof.body.events.some((e) => e.type === 'openRound') && proof.body.events.some((e) => e.type === 'snapshot'))
    assert.equal(proof.body.feeds.length, 13)
    for (const e of proof.body.events) assert.ok(e.method && /^0x[0-9a-f]{8}$/.test(e.selector), JSON.stringify(e))
    assert.deepEqual(proof.body.methods['0x1ceb9a0b'], { type: 'snapshot', method: 'postSnapshot' })
    assert.equal(proof.body.events.find((e) => e.type === 'snapshot').selector, '0x1ceb9a0b')
    const snapEv = proof.body.events.find((e) => e.type === 'snapshot')
    const snap = await fetch(base + snapEv.url)
    const text = await snap.text()
    const { createHash } = await import('node:crypto')
    assert.equal('0x' + createHash('sha256').update(text).digest('hex'), snapEv.hash)
    const card = await get(`/api/card/D-2026-10-19/${u.address}.png`)
    assert.equal((await get(`/api/card/D-2026-10-19/${acct(99).address}.png`)).status, 200)   // generic card, never a broken preview
    assert.equal(card.status, 200)
    assert.match(card.headers.get('content-type'), /image\/(png|svg)/)
    if (card.headers.get('content-type') === 'image/png') assert.equal(card.body.subarray(1, 4).toString(), 'PNG')
    const share = await fetch(`${base}/r/D-2026-10-19/${u.address}`)
    const html = await share.text()
    assert.match(html, /og:image" content="https:\/\/tapeward\.live\/api\/card\/D-2026-10-19\/0x/)
    assert.equal((await get('/api/round/NOPE-1')).status, 404)
    assert.equal((await get('/api/wallet/0x12')).status, 400)
  } finally { await close() }
})
