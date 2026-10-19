import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basketBp, feedBp, pickScore, rankBoard } from '../score.mjs'
import { computeBps } from '../book.mjs'
import { FEEDS } from './helpers.mjs'

test('basket bp = equal-weight mean, truncated toward zero (contract math)', () => {
  assert.equal(basketBp([100n], [101n]), 100)
  assert.equal(basketBp([300n], [299n]), -33)   // −33.33 → −33 (toward zero, not −34)
  assert.equal(basketBp([100n, 100n], [101n, 100n]), 50)
  // mean of exact ratios, truncated once: (+33.33 + +33.33 + +33.33)/3 = 33.33 → 33
  assert.equal(basketBp([300n, 300n, 300n], [301n, 301n, 301n]), 33)
  // per-feed truncation would give a different answer here: 3 × 0.6667 bp / 3 → 0 (exact ratios: 0.666 → 0); and 1.5+1.5 → 1
  assert.equal(basketBp([20000n, 20000n], [20003n, 20003n]), 1)
  assert.equal(basketBp([35922540127n], [35736888606n]), -51)
  assert.equal(feedBp(35922540127n, 35736888606n), -51)
})

test('computeBps follows feeds.json order RED[6] BLUE[6] REF', () => {
  const start = FEEDS.map(() => ({ answer: '10000' }))
  const end = FEEDS.map((f) => ({ answer: f.basket === 'RED' ? '10120' : f.basket === 'BLUE' ? '9970' : '10010' }))
  assert.deepEqual(computeBps(FEEDS, start, end), { redBp: 120, blueBp: -30, refBp: 10, spreadBp: 150 })
})

test('pick score: side 100 + max(0, 100 − |spread − actual| / 5)', () => {
  assert.deepEqual(pickScore({ side: 0, spreadBp: 120 }, 120).score, 200)
  assert.equal(pickScore({ side: 'RED', spreadBp: 100 }, 120).score, 196)          // 100 + 100 − 4
  assert.equal(pickScore({ side: 1, spreadBp: -100 }, 120).score, 56)              // wrong side, |−220|/5 = 44
  assert.equal(pickScore({ side: 0, spreadBp: 0 }, 0).score, 100)                 // 0 spread: nobody gets the 100
  assert.equal(pickScore({ side: 1, spreadBp: 0 }, 0).sideRight, false)
  assert.equal(pickScore({ side: 0, spreadBp: 2000 }, -1000).score, 0)             // floor at 0
  assert.equal(pickScore({ side: 0, spreadBp: 3 }, 1).score, 199.6)               // fractional: 100 + 100 − 0.4
  assert.equal(pickScore({ side: 0, spreadBp: 3 }, 1).scoreX10, 1996)
  assert.equal(pickScore({ side: 0, spreadBp: 3 }, null).score, null)
})

test('board: best slot per wallet, ties → earlier signedAt, then lower address', () => {
  const A = '0x00000000000000000000000000000000000000aa', B = '0x00000000000000000000000000000000000000bb', C = '0x00000000000000000000000000000000000000cc'
  const picks = [
    { picker: B, slot: 0, side: 0, spreadBp: 50, signedAt: 100 },
    { picker: A, slot: 0, side: 0, spreadBp: 50, signedAt: 200 },   // same score as B, later → below B
    { picker: C, slot: 0, side: 1, spreadBp: -10, signedAt: 50 },
    { picker: C, slot: 1, side: 0, spreadBp: 60, signedAt: 300 },   // C's best slot: exact
    { picker: '0x00000000000000000000000000000000000000ab', slot: 0, side: 0, spreadBp: 50, signedAt: 100 },   // ties B on time → lower address first? B=..bb > ..ab
  ]
  const b = rankBoard(picks, 60)
  assert.deepEqual(b.map((r) => [r.rank, r.picker.slice(-2), r.best.slot, r.best.score]), [[1, 'cc', 1, 200], [2, 'ab', 0, 198], [3, 'bb', 0, 198], [4, 'aa', 0, 198]])
  assert.equal(b[0].slots.length, 2)
})
