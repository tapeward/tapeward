import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { normaliseEvent, marketProb, buildSnapshot, canonical, sha256Hex, FIXTURE_DIR, candidates, createKalshi } from '../kalshi.mjs'
import { openStore } from '../store.mjs'
import { fixedClock } from '../config.mjs'
import { quiet } from './helpers.mjs'

const ev = (t) => JSON.parse(readFileSync(`${FIXTURE_DIR}events/${t}.json`, 'utf8'))
const all = () => Object.fromEntries(readdirSync(FIXTURE_DIR + 'events').map((f) => [f.slice(0, -5), ev(f.slice(0, -5))]))

test('market probability: tight book → mid, else last; settled → 1/0', () => {
  assert.equal(marketProb({ yes_bid_dollars: '0.3800', yes_ask_dollars: '0.3900', last_price_dollars: '0.5000' }), 0.385)
  assert.equal(marketProb({ yes_bid_dollars: '0.1000', yes_ask_dollars: '0.5000', last_price_dollars: '0.3000' }), 0.3)
  assert.equal(marketProb({ result: 'yes', last_price_dollars: '0.4' }), 1)
  assert.equal(marketProb({ result: 'no', last_price_dollars: '0.4' }), 0)
})

test('normalise a Senate race (TX fixture)', () => {
  const r = normaliseEvent(ev('SENATETX-26'))
  assert.equal(r.st, 'TX'); assert.equal(r.race, 'senate'); assert.equal(r.special, false)
  assert.ok(r.pD > 0.55 && r.pD < 0.7, `pD ${r.pD}`)
  assert.ok(Math.abs(r.pD + r.pR + r.pO - 1) < 0.001)
  assert.ok(r.vol > 1_000_000)
  assert.equal(r.status, 'active'); assert.equal(r.result, null)
})

test('independents count as "other" (NE Senate) and specials are flagged (OH)', () => {
  const ne = normaliseEvent(ev('SENATENE-26'))
  assert.ok(ne.pO > 0.2); assert.equal(ne.others[0].name, 'Dan Osborn')
  const oh = normaliseEvent(ev('SENATEOHS-26'))
  assert.equal(oh.st, 'OH'); assert.equal(oh.special, true)
  const gov = normaliseEvent(ev('GOVPARTYWI-26'))
  assert.equal(gov.race, 'gov'); assert.equal(gov.st, 'WI')
  assert.equal(normaliseEvent(ev('GOVPARTYND-26')), null)   // event without markets
})

test('snapshot: control + one map race per state, canonical hash is stable', () => {
  const s = buildSnapshot(all(), 1792400000)
  assert.ok(s.control.house.pD > 0.8)
  assert.ok(s.control.senate.pD > 0.4)
  const map = s.states.filter((x) => x.map)
  assert.equal(new Set(map.map((x) => x.st)).size, map.length)
  assert.equal(map.find((x) => x.st === 'OH').race, 'senate')    // special Senate before governor
  assert.equal(map.find((x) => x.st === 'WI').race, 'gov')       // no Senate race in WI
  const j = canonical(s)
  assert.equal(j, canonical(JSON.parse(j)))
  assert.equal(sha256Hex(j), sha256Hex(canonical(buildSnapshot(all(), 1792400000))))
  assert.match(sha256Hex(j), /^0x[0-9a-f]{64}$/)
  assert.ok(candidates().includes('SENATEFLS-26'))
})

test('poller in fixtures mode stores the snapshot and freezes it by hash', async () => {
  const store = openStore({ memory: true })
  const k = createKalshi({ store, clock: fixedClock('2026-10-20T15:00:00Z'), mode: 'fixtures', log: quiet })
  const cur = await k.poll()
  assert.ok(cur.snapshot.states.length > 60)
  const f = k.freeze()
  assert.equal(store.getSnapshot(f.hash).json, cur.json)
  assert.equal(k.view().states.length, cur.snapshot.states.length)
})

test('live mode: 404 = no race, errors are counted', async () => {
  const store = openStore({ memory: true })
  const tx = ev('SENATETX-26')
  const fetchImpl = async (u) => (u.includes('/SENATETX-26?') ? { status: 200, ok: true, json: async () => tx } : u.includes('CONTROLH') ? { status: 500, ok: false } : { status: 404, ok: false })
  const k = createKalshi({ store, clock: fixedClock('2026-10-20T15:00:00Z'), mode: 'live', fetchImpl, log: quiet })
  const cur = await k.poll()
  assert.equal(cur.snapshot.states.length, 1)
  assert.match(k.status().error, /1 events failed/)
})
