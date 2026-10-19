import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proofLine, cardSvg, renderCard } from '../card.mjs'
import { makeApp, signPick, acct, nowS } from './helpers.mjs'

const TX = '0x' + 'ab'.repeat(32)
test('card status line follows the pick: signed → recorded on Robinhood Chain → scored', () => {
  assert.equal(proofLine({ anchor: null, score: null }), 'signed · recording on Robinhood Chain…')
  assert.equal(proofLine({ anchor: { n: 3, tx: TX }, score: null }), 'recorded on Robinhood Chain · tx 0xabab…abab')
  assert.equal(proofLine({ anchor: { n: 3, tx: 'mock-' + TX }, score: null }), 'recorded on Robinhood Chain')
  assert.equal(proofLine({ anchor: { n: 3, tx: TX }, score: 187.4, settleTx: TX }), 'scored: 187.4 pts · settle tx 0xabab…abab')
  const svg = cardSvg({ address: acct(1).address, side: 'RED', spreadBp: 120, signedAt: '2026-10-20 14:40 UTC', roundLabel: 'X', anchor: null, score: null, actual: null, live: null })
  assert.match(svg, /signed · recording on Robinhood Chain…/)
  // wording rule: the card never says merkle / root / anchor / stamp / hash (SVG attribute text-anchor aside)
  for (const st of [{ anchor: null }, { anchor: { n: 1, tx: TX } }, { anchor: { n: 1, tx: TX }, score: 150, settleTx: TX, actual: { redBp: 1, blueBp: 0, spreadBp: 1 } }]) {
    const text = cardSvg({ address: acct(1).address, side: 'RED', spreadBp: 120, signedAt: 'x', roundLabel: 'X', score: null, actual: null, live: null, ...st }).replace(/text-anchor="[a-z]+"/g, '').replace(/<[^>]+>/g, ' ')
    assert.doesNotMatch(text, /merkle|root|anchor|stamp|hash/i)
  }
})

test('share card states through a round (API view model)', async () => {
  const app = makeApp({ now: '2026-10-19T08:00:00Z' })
  await app.rounds.tick()
  const u = acct(21), id = 'D-2026-10-19'
  app.clock.set('2026-10-19T08:10:00Z')
  assert.ok((await app.picks.submit(await signPick(u, { round: id, side: 0, spreadBp: 30, slot: 0, signedAt: nowS(app) }), { ip: 'c' })).ok)
  const line = async () => proofLine(await app.api.cardModel(id, u.address))
  await app.rounds.tick()   // the desk pick was recorded at 08:00: the next record waits for the 09:00 hour
  assert.equal(await line(), 'signed · recording on Robinhood Chain…')
  app.clock.set('2026-10-19T09:00:02Z'); await app.rounds.tick()
  assert.equal(await line(), 'recorded on Robinhood Chain')   // mock tx ids are not shown
  for (const t of ['2026-10-19T13:28:30Z', '2026-10-19T20:10:31Z']) { app.clock.set(t); await app.rounds.tick() }
  const m = await app.api.cardModel(id, u.address)
  assert.ok(m.score != null)
  assert.equal(proofLine(m), `scored: ${m.score} pts`)
  assert.equal((await app.api.cardModel(id, acct(22).address)).generic, true)
  app.stop()
})

test('sealed card never reveals side or spread; no pick → generic card (200), share page text sealed too', async () => {
  const app = makeApp({ now: '2026-10-19T08:00:00Z' })
  await app.rounds.tick()
  const u = acct(23), id = 'D-2026-10-19'
  app.clock.set('2026-10-19T08:30:00Z')
  assert.ok((await app.picks.submit(await signPick(u, { round: id, side: 1, spreadBp: -137, slot: 0, signedAt: nowS(app) }), { ip: 's' })).ok)
  const m = await app.api.cardModel(id, u.address)
  assert.equal(m.sealed, true); assert.equal(m.sealedUntil, '13:28 UTC')
  assert.equal(m.side, undefined); assert.equal(m.spreadBp, undefined)
  const text = cardSvg(m).replace(/<[^>]+>/g, ' ')
  assert.match(text, /made a call/); assert.match(text, /Sealed until 13:28 UTC/)
  assert.doesNotMatch(text, /BLUE beats|RED beats|1\.37|137|\bBLUE\b|\bRED\b/)
  // via HTTP: card is an image (200), share page description is sealed
  const { createServer } = await import('node:http')
  const srv = createServer(async (req, res) => { if (!(await app.api(req, res))) { res.writeHead(404); res.end() } })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    for (const path of [`/api/card/${id}/${u.address}.png`, `/api/card/${id}/${acct(24).address}.png`, `/api/card/NOPE-1/${u.address}.png`]) {
      const r = await fetch(base + path)
      assert.equal(r.status, 200, path); assert.match(r.headers.get('content-type'), /^image\//)
      await r.arrayBuffer()
    }
    const html = await (await fetch(`${base}/r/${id}/${u.address}`)).text()
    assert.match(html, /made a call for Daily · Mon 19 Oct · sealed until 13:28 UTC/)
    assert.doesNotMatch(html, /BLUE beats|RED beats/)
    // after picks close the full card is back
    app.clock.set('2026-10-19T13:28:30Z'); await app.rounds.tick()
    const full = await app.api.cardModel(id, u.address)
    assert.equal(full.sealed, undefined); assert.equal(full.side, 'BLUE'); assert.equal(full.spreadBp, -137)
    assert.match(await (await fetch(`${base}/r/${id}/${u.address}`)).text(), /BLUE beats RED by 1\.37 %/)
  } finally { app.stop(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)) }
  const g = await renderCard({ generic: true, address: acct(1).address, roundLabel: '' })
  assert.match(g.type, /^image\//)
})
