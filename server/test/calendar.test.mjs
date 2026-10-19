import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULES } from './helpers.mjs'
import { sessionOf, dailyPlan, electionPlan, roundsDue, roundHex, roundFromHex, roundStatus, isUsDst, lastClosedSessions, upcomingDaily } from '../calendar.mjs'

const I = (s) => Date.parse(s)
test('market hours switch with US DST (ends Sun 1 Nov 2026)', () => {
  const fri = sessionOf('2026-10-30'), mon = sessionOf('2026-11-02'), sun = sessionOf('2026-11-01'), sat = sessionOf('2026-10-31')
  assert.equal(new Date(fri.open).toISOString(), '2026-10-30T13:30:00.000Z')
  assert.equal(new Date(fri.close).toISOString(), '2026-10-30T20:00:00.000Z')
  assert.equal(new Date(mon.open).toISOString(), '2026-11-02T14:30:00.000Z')
  assert.equal(new Date(mon.close).toISOString(), '2026-11-02T21:00:00.000Z')
  assert.equal(sun.tradingDay, false); assert.equal(sat.tradingDay, false)
  assert.equal(isUsDst(I('2026-11-01T05:59:59Z')), true)
  assert.equal(isUsDst(I('2026-11-01T06:00:00Z')), false)
  const tue = sessionOf('2026-11-03')
  assert.equal(new Date(tue.open).toISOString(), '2026-11-03T14:30:00.000Z')
  assert.equal(sessionOf('2026-11-26').tradingDay, false)   // Thanksgiving
})

test('daily round plan: lock = open, picks close 2 min before, score = close, created 24 h ahead', () => {
  const p = dailyPlan('2026-10-20', RULES)
  assert.equal(p.id, 'D-2026-10-20')
  assert.equal(new Date(p.lockTime).toISOString(), '2026-10-20T13:30:00.000Z')
  assert.equal(new Date(p.picksClose).toISOString(), '2026-10-20T13:28:00.000Z')
  assert.deepEqual(p.scoreTimes.map((t) => new Date(t).toISOString()), ['2026-10-20T20:00:00.000Z'])
  assert.equal(new Date(p.createAt).toISOString(), '2026-10-19T13:30:00.000Z')
  // D-20 opens when D-19 (the first daily round, today) scores
  assert.equal(new Date(p.opensAt).toISOString(), '2026-10-19T20:00:00.000Z')
  // first daily round (Mon 19 Oct): no previous round → opens at creation (24 h before lock, so at once when the service starts)
  const first = dailyPlan('2026-10-19', RULES)
  assert.equal(first.opensAt, first.createAt)
  assert.equal(new Date(first.picksClose).toISOString(), '2026-10-19T13:28:00.000Z')
  assert.equal(new Date(first.scoreTimes[0]).toISOString(), '2026-10-19T20:00:00.000Z')
  // next day opens when the previous round scores (Tue close), later than its creation
  const w = dailyPlan('2026-10-21', RULES)
  assert.equal(new Date(w.opensAt).toISOString(), '2026-10-20T20:00:00.000Z')
  // Monday: created Sunday 13:30, after Friday's close → opens at creation
  const m = dailyPlan('2026-10-26', RULES)
  assert.equal(new Date(m.opensAt).toISOString(), '2026-10-25T13:30:00.000Z')
  // after the DST switch
  const n2 = dailyPlan('2026-11-02', RULES)
  assert.equal(new Date(n2.lockTime).toISOString(), '2026-11-02T14:30:00.000Z')
  assert.equal(new Date(n2.picksClose).toISOString(), '2026-11-02T14:28:00.000Z')
  assert.equal(new Date(n2.scoreTimes[0]).toISOString(), '2026-11-02T21:00:00.000Z')
  assert.equal(dailyPlan('2026-10-24', RULES), null)
})

test('ELECTION-2026 times', () => {
  const e = electionPlan(RULES, I('2026-10-19T08:00:00Z'))
  assert.equal(e.id, 'ELECTION-2026')
  assert.equal(new Date(e.picksClose).toISOString(), '2026-11-03T20:58:00.000Z')
  assert.equal(new Date(e.lockTime).toISOString(), '2026-11-03T21:00:00.000Z')
  assert.deepEqual(e.scoreTimes.map((t) => new Date(t).toISOString()), ['2026-11-04T21:00:00.000Z', '2026-11-06T21:00:00.000Z'])
  assert.deepEqual(e.scoreLabels, ['Day one', 'Aftershock'])
  // lock = the close of Election Day (standard time)
  assert.equal(e.lockTime, sessionOf('2026-11-03').close)
})

test('roundsDue creates the election at once and daily rounds 24 h before lock', () => {
  const ids = (t, have) => roundsDue(I(t), RULES, new Set(have)).map((r) => r.id)
  // service starting on Mon 19 Oct before 13:28 creates today's round at once
  assert.deepEqual(ids('2026-10-19T08:00:00Z', []), ['ELECTION-2026', 'D-2026-10-19'])
  assert.deepEqual(ids('2026-10-19T13:28:00Z', ['ELECTION-2026']), [])   // too late for today (picks closed)
  assert.deepEqual(ids('2026-10-19T13:30:00Z', ['ELECTION-2026']), ['D-2026-10-20'])
  assert.deepEqual(ids('2026-10-20T13:30:00Z', ['ELECTION-2026', 'D-2026-10-20']), ['D-2026-10-21'])
  assert.deepEqual(ids('2026-11-04T00:00:00Z', ['D-2026-11-03']), ['D-2026-11-04'])   // created 14:30 on the 3rd (late start still creates it)
  assert.deepEqual(ids('2026-11-03T14:29:00Z', ['ELECTION-2026', 'D-2026-11-03']), [])
  assert.deepEqual(ids('2026-11-03T14:30:00Z', ['D-2026-11-03']), ['ELECTION-2026', 'D-2026-11-04'])
  assert.deepEqual(ids('2026-11-03T21:00:00Z', ['D-2026-11-04']), [])   // election past picks close → never created late
})

test('round ids are UTF-8 bytes32 (same as contracts/typed-data.json)', () => {
  assert.equal(roundHex('D-2026-10-20'), '0x442d323032362d31302d32300000000000000000000000000000000000000000')
  assert.equal(roundFromHex(roundHex('ELECTION-2026')), 'ELECTION-2026')
})

test('round status', () => {
  const p = dailyPlan('2026-10-21', RULES)
  assert.equal(roundStatus(p, I('2026-10-20T19:59:00Z')), 'upcoming')
  assert.equal(roundStatus(p, I('2026-10-21T10:00:00Z')), 'open')
  assert.equal(roundStatus(p, I('2026-10-21T13:29:00Z')), 'closing')
  assert.equal(roundStatus(p, I('2026-10-21T15:00:00Z')), 'live')
  assert.equal(roundStatus(p, I('2026-10-21T20:05:00Z')), 'scoring')
  assert.equal(roundStatus(p, I('2026-10-21T20:15:00Z'), 1), 'settled')
  const e = electionPlan(RULES, 0)
  assert.equal(roundStatus(e, I('2026-11-05T00:00:00Z'), 1), 'live')   // Day one settled, Aftershock running
})

test('last closed sessions + upcoming', () => {
  const s = lastClosedSessions(I('2026-10-19T08:00:00Z'), 6)
  assert.deepEqual(s.map((x) => x.day), ['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12', '2026-10-09'])
  assert.equal(upcomingDaily(I('2026-10-19T08:00:00Z'), RULES, 2)[0].id, 'D-2026-10-19')
  assert.equal(upcomingDaily(I('2026-10-19T14:00:00Z'), RULES, 2)[0].id, 'D-2026-10-20')
})
