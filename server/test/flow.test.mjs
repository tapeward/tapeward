// End to end on a fake chain (mock RaceBook): create → desk pick → picks → hourly anchors → final anchor → settle → board → verify.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeFunctionResult } from 'viem'
import { makeApp, signPick, acct, nowS, FEEDS } from './helpers.mjs'
import { verifyRound } from '../verify.mjs'
import { anchorDue } from '../rounds.mjs'
import { FEED_ABI } from '../chain.mjs'
import { roundHex } from '../calendar.mjs'

const I = (s) => Date.parse(s)
const H = 3_600_000

test('anchorDue cadence (pure)', () => {
  const round = { opensAt: I('2026-10-19T13:30:00Z'), picksClose: I('2026-10-20T13:28:00Z'), lockTime: I('2026-10-20T13:30:00Z') }
  const d = (now, last, ch = true) => anchorDue({ now: I(now), round, last: last && { ...last, at: I(last.at) }, leavesChanged: ch })
  assert.equal(d('2026-10-19T13:30:05Z', null), 'first')                    // first leaves → anchor at once
  assert.equal(d('2026-10-19T14:59:59Z', { at: '2026-10-19T14:00:02Z', status: 'mock' }), null)
  assert.equal(d('2026-10-19T14:00:01Z', null, false), null)                 // nothing to anchor
  assert.equal(d('2026-10-19T14:40:00Z', { at: '2026-10-19T14:00:02Z', status: 'mock' }), null)   // once per hour
  assert.equal(d('2026-10-19T15:00:00Z', { at: '2026-10-19T14:00:02Z', status: 'mock' }), 'hourly')
  assert.equal(d('2026-10-20T13:28:00Z', { at: '2026-10-20T13:00:02Z', status: 'mock' }, false), 'final')   // final even if unchanged
  assert.equal(d('2026-10-20T13:29:00Z', { at: '2026-10-20T13:28:05Z', status: 'mock', final: true }), null)
  assert.equal(d('2026-10-20T13:30:00Z', null), null)                        // never after lock
  assert.equal(d('2026-10-19T12:00:00Z', null), null)                        // never before open
})

test('daily round end to end + verify.mjs agrees with the board', async () => {
  const app = makeApp({ now: '2026-10-19T08:00:00Z' })
  await app.rounds.tick()
  const ids = app.store.rounds().map((r) => r.id).sort()
  assert.deepEqual(ids, ['D-2026-10-19', 'ELECTION-2026'])   // today's round is created when the service starts before its lock
  const D = app.store.getRound('D-2026-10-19')
  assert.equal(D.openStatus, 'mock')
  assert.ok(D.desk, 'house desk picked')
  assert.equal(app.store.picksOf(D.id).length, 1)
  // the desk pick is anchored at once (first anchor), in both rounds
  assert.equal(app.store.anchorsOf(D.id).length, 1); assert.equal(app.store.anchorsOf(D.id)[0].count, 1)
  assert.equal(app.store.anchorsOf('ELECTION-2026').length, 1)

  // picks
  app.clock.set('2026-10-19T08:10:00Z')
  const users = [1, 2, 3, 4].map(acct)
  const sub = async (a, p) => app.picks.submit(await signPick(a, { round: D.id, signedAt: nowS(app), slot: 0, ...p }), { ip: 't' })
  assert.ok((await sub(users[0], { side: 0, spreadBp: 40 })).ok)
  assert.ok((await sub(users[1], { side: 1, spreadBp: -25 })).ok)
  assert.equal((await sub(users[2], { side: 0, spreadBp: 10, slot: 1 })).reason, 'no_slot')
  assert.equal((await sub(users[2], { side: 0, spreadBp: 10, signedAt: nowS(app) - 3600 })).reason, 'bad_time')
  const forged = await signPick(users[2], { round: D.id, side: 0, spreadBp: 10, slot: 0, signedAt: nowS(app) })
  assert.equal((await app.picks.submit({ ...forged, address: users[3].address }, { ip: 't' })).reason, 'bad_signature')

  // hourly anchors
  await app.rounds.tick()
  assert.equal(app.store.anchorsOf(D.id).length, 1, 'no second anchor inside the same hour')
  app.clock.set('2026-10-19T09:00:03Z'); await app.rounds.tick()
  let as = app.store.anchorsOf(D.id)
  assert.equal(as.length, 2); assert.equal(as[1].count, 3); assert.equal(as[1].status, 'mock')
  app.clock.set('2026-10-19T10:00:03Z'); await app.rounds.tick()
  assert.equal(app.store.anchorsOf(D.id).length, 2, 'unchanged leaves → no new anchor')
  // replacement (newer signedAt) + a new pick
  app.clock.set('2026-10-19T10:10:00Z')
  const rep = await sub(users[1], { side: 0, spreadBp: 15 })
  assert.ok(rep.ok); assert.equal(rep.replaced, true)
  assert.equal((await app.picks.submit(await signPick(users[1], { round: D.id, side: 1, spreadBp: -5, slot: 0, signedAt: nowS(app) - 60 }), { ip: 't' })).reason, 'stale')
  assert.ok((await sub(users[2], { side: 1, spreadBp: -60 })).ok)
  app.clock.set('2026-10-19T11:00:02Z'); await app.rounds.tick()
  as = app.store.anchorsOf(D.id)
  assert.equal(as.length, 3); assert.equal(as[2].count, 4); assert.equal(as[2].n, 3)

  // wallet receipt: anchored in root #3 for the replaced pick
  const w = await app.views.wallet(users[1].address)
  assert.equal(w.picks.find((x) => x.round === D.id).anchored.n, 3)
  // counters in /api/state: desk pick counted and marked, anchors + last anchor per round
  const c = (await app.views.state()).rounds.find((r) => r.id === D.id).counters
  assert.deepEqual([c.picks, c.wallets, c.deskPicks, c.userPicks, c.anchors, c.lastAnchor.n, c.pending], [4, 4, 1, 3, 3, 3, 0])

  // sealed before picks close
  const sealed = app.views.picksDoc(D.id)
  assert.equal(sealed.sealed, true); assert.equal(sealed.leaves[0].picker, undefined)

  // picks close → final anchor (unchanged leaves → the last root is marked final)
  app.clock.set('2026-10-19T13:28:00Z')
  assert.equal((await sub(users[3], { side: 0, spreadBp: 5 })).reason, 'closed')
  await app.rounds.tick()
  as = app.store.anchorsOf(D.id)
  assert.equal(as.length, 3); assert.equal(as.at(-1).final, true)
  // anchoring after lock is refused (contract rule mirrored in mock)
  app.clock.set('2026-10-19T13:31:00Z')
  await assert.rejects(app.book.anchor(D, as[2].root, 4, 'x', 4), /AnchorAfterLock/)

  // board is live/unofficial before settle
  app.clock.set('2026-10-19T16:00:00Z')
  let b = await app.views.board(D.id)
  assert.equal(b.official, false); assert.equal(b.result.live, true); assert.equal(b.count, 4)

  // settle at close + 10 min (+30 s margin)
  app.clock.set('2026-10-19T20:05:00Z'); await app.rounds.tick()
  assert.equal(app.store.resultsOf(D.id).filter((r) => r.status === 'mock').length, 0, 'too early (SETTLE_DELAY)')
  app.clock.set('2026-10-19T20:10:31Z'); await app.rounds.tick()
  const res = app.store.resultsOf(D.id)[0]
  assert.equal(res.status, 'mock')
  // start/end rounds are exactly the ones settle() accepts
  const lockS = Math.floor(D.lockTime / 1000), closeS = Math.floor(D.scoreTimes[0] / 1000)
  FEEDS.forEach((f, k) => {
    assert.equal(BigInt(res.start[k].roundId) & ((1n << 64n) - 1n), BigInt(app.fc.truthAt(k, lockS)))
    assert.equal(BigInt(res.end[k].roundId) & ((1n << 64n) - 1n), BigInt(app.fc.truthAt(k, closeS)))
  })
  b = await app.views.board(D.id)
  assert.equal(b.official, true)
  assert.equal(b.result.spreadBp, res.spreadBp)
  assert.equal(app.rounds.statusOf(D), 'settled')

  // verify.mjs against a RaceBook emulated from the server's own records
  const doc = app.views.picksDoc(D.id)
  assert.equal(doc.sealed, false)
  const proxies = FEEDS.map((f) => f.proxy)
  const read = async ({ address, functionName, args }) => {
    if (functionName === 'round') return { exists: true, picksClose: BigInt(D.picksClose / 1000), lockTime: BigInt(lockS), scoreTimes: [BigInt(closeS)], anchorCount: 3, root: as[2].root, count: 4, settled: [true] }
    if (functionName === 'anchorAt') return { root: app.store.anchorsOf(D.id)[args[1] - 1].root, count: app.store.anchorsOf(D.id)[args[1] - 1].count, at: 0n }
    if (functionName === 'feeds') return [proxies.slice(0, 6), proxies.slice(6, 12), proxies[12]]
    if (functionName === 'result') {
      const pt = (p) => ({ roundId: BigInt(p.roundId), updatedAt: BigInt(p.updatedAt), answer: BigInt(p.answer) })
      return { settled: true, redBp: BigInt(res.redBp), blueBp: BigInt(res.blueBp), refBp: BigInt(res.refBp), spreadBp: BigInt(res.spreadBp), start: res.start.map(pt), end: res.end.map(pt) }
    }
    if (functionName === 'getRoundData') {
      const data = (await import('viem')).encodeFunctionData({ abi: FEED_ABI, functionName: 'getRoundData', args })
      const hex = await app.fc.reads.call(address, data)
      return (await import('viem')).decodeFunctionResult({ abi: FEED_ABI, functionName: 'getRoundData', data: hex })
    }
    throw new Error(functionName)
  }
  const rep2 = await verifyRound({ round: D.id, picksUrl: 'x', racebook: '0x00000000000000000000000000000000000000b0', fetchJson: async () => JSON.parse(JSON.stringify(doc)), read })
  assert.deepEqual(rep2.errors, [])
  assert.equal(rep2.root, as[2].root)
  const vb = rep2.results[0].board
  assert.deepEqual(vb.map((r) => [r.picker, r.best.score]), b.rows.map((r) => [r.address, r.score]))
  // a tampered leaf is caught
  const bad = JSON.parse(JSON.stringify(doc)); bad.leaves[0].spreadBp += 1
  const rep3 = await verifyRound({ round: D.id, picksUrl: 'x', racebook: '0x00000000000000000000000000000000000000b0', fetchJson: async () => bad, read, checkFeeds: false })
  assert.equal(rep3.ok, false)

  // desk record counts the settled round
  await app.kalshi.poll()
  const st = await app.views.state()
  assert.equal(st.desk.record.scored, 1)
  assert.equal(st.rounds.find((r) => r.role === 'current').id, D.id)
  assert.ok(st.kalshi.states.length > 60)
  app.stop()
})

test('slot rules: holders get 3 slots in ELECTION-2026, daily stays 1; lost holders are voided at picks close', async () => {
  const H1 = acct(50), N1 = acct(51)
  const CA = '0x00000000000000000000000000000000000000c4'
  const app = makeApp({ now: '2026-10-21T15:00:00Z', token: { name: 'TAPEWARD', symbol: null, ca: CA, holder_min: 1000, launch_at: '2026-10-21T14:00:00Z' }, balances: { [H1.address.toLowerCase()]: 2000n * 10n ** 18n } })
  await app.rounds.tick()
  const E = 'ELECTION-2026', D = 'D-2026-10-22'
  assert.ok(app.store.getRound(D))
  const sub = (a, p) => signPick(a, { signedAt: nowS(app), ...p }).then((b) => app.picks.submit(b, { ip: 'x' + a.address }))
  app.clock.set('2026-10-21T20:30:00Z')
  assert.ok((await sub(H1, { round: E, side: 0, spreadBp: 100, slot: 0 })).ok)
  assert.ok((await sub(H1, { round: E, side: 1, spreadBp: -50, slot: 1 })).ok)
  assert.ok((await sub(H1, { round: E, side: 0, spreadBp: 0, slot: 2 })).ok)
  assert.equal((await sub(H1, { round: E, side: 0, spreadBp: 0, slot: 3 })).reason, 'no_slot')
  assert.equal((await sub(H1, { round: D, side: 0, spreadBp: 0, slot: 1 })).reason, 'no_slot')
  assert.ok((await sub(H1, { round: D, side: 0, spreadBp: 0, slot: 0 })).ok)
  assert.equal((await sub(N1, { round: E, side: 0, spreadBp: 0, slot: 1 })).reason, 'no_slot')
  assert.ok((await sub(N1, { round: E, side: 0, spreadBp: 0, slot: 0 })).ok)
  const w = await app.views.wallet(H1.address)
  assert.equal(w.slots[E], 3); assert.equal(w.slots[D], 1)
  // H1 sells before picks close → extra slots voided at the final anchor
  delete app.fc.balances[H1.address.toLowerCase()]
  app.clock.set('2026-11-03T20:58:10Z')
  await app.rounds.tick()
  const live = app.store.picksOf(E).filter((p) => !p.void)
  assert.deepEqual(live.filter((p) => p.picker === H1.address).map((p) => p.slot), [0])
  const fin = app.store.anchorsOf(E).at(-1)
  assert.equal(fin.final, true); assert.equal(fin.count, live.length)
  app.stop()
})

test('chain.findRoundAt finds the round settle() accepts (fake feed, binary search)', async () => {
  const app = makeApp({ now: '2026-10-25T00:00:00Z' })
  for (const t of ['2026-10-20T13:30:00Z', '2026-10-02T00:00:07Z', '2026-10-24T23:59:59Z']) {
    const tS = Math.floor(I(t) / 1000)
    for (const k of [0, 5, 12]) {
      const r = await app.fc.chain.findRoundAt(FEEDS[k], tS)
      assert.equal(Number(BigInt(r.roundId) & ((1n << 64n) - 1n)), app.fc.truthAt(k, tS), `${FEEDS[k].symbol} @ ${t}`)
      assert.ok(r.updatedAt <= tS)
    }
  }
  app.stop()
})

test('chain.rounds: an upstream RPC error is never read as a missing round', async () => {
  const { createChain } = await import('../chain.mjs')
  const app = makeApp({ now: '2026-10-25T00:00:00Z' })
  let fail = true
  const reads = { ...app.fc.reads, async batch(cs) { const r = await app.fc.reads.batch(cs); return fail ? r.map((x, i) => (i === 1 ? Object.assign(new Error('internal error'), { rpc: { code: -32603, message: 'internal error' } }) : x)) : r } }
  const ch = createChain({ reads })
  const f = FEEDS[0], tS = Math.floor(I('2026-10-20T13:30:00Z') / 1000)
  await assert.rejects(ch.findRoundAt(f, tS), /internal error/)
  fail = false
  const r = await ch.findRoundAt(f, tS)
  assert.equal(Number(BigInt(r.roundId) & ((1n << 64n) - 1n)), app.fc.truthAt(0, tS))
  app.stop()
})
