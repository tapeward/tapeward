import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashTypedData, recoverTypedDataAddress, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { TYPED, signPick, acct } from './helpers.mjs'
import { typedDataFor, parsePick } from '../picks.mjs'
import { typedSpec } from '../config.mjs'
import { roundHex } from '../calendar.mjs'
import { RULES } from './helpers.mjs'

test('server typed data = contracts/typed-data.json (domain without verifyingContract)', () => {
  const s = typedSpec()
  assert.deepEqual(s.domain, { name: 'TAPEWARD', version: '1', chainId: 4663 })
  assert.deepEqual(s.types.Pick, TYPED.types.Pick)
})

test('contract worked example: digest + signature recover to the example picker', async () => {
  const ex = TYPED.example
  const p = { roundHex: ex.message.round, side: ex.message.side, spreadBp: ex.message.spreadBp, slot: ex.message.slot, signedAt: ex.message.signedAt }
  assert.equal(roundHex(ex.roundName), ex.message.round)
  assert.equal(hashTypedData(typedDataFor(p)), ex.digest)
  assert.equal(getAddress(await recoverTypedDataAddress({ ...typedDataFor(p), signature: ex.signature })), ex.picker)
})

test('a throwaway viem key signs, the server recovers it; tampering breaks it', async () => {
  const a = privateKeyToAccount(generatePrivateKey())
  const b = await signPick(a, { round: 'D-2026-10-20', side: 1, spreadBp: -75, slot: 0, signedAt: 1792500000 })
  const parsed = parsePick(b, RULES)
  assert.ok(parsed.ok)
  assert.equal(await recoverTypedDataAddress({ ...typedDataFor(parsed.pick), signature: b.signature }), a.address)
  const t = parsePick({ ...b, pick: { ...b.pick, spreadBp: -76 } }, RULES).pick
  assert.notEqual(await recoverTypedDataAddress({ ...typedDataFor(t), signature: b.signature }), a.address)
})

test('parsePick shape rules', () => {
  const ok = (p) => parsePick({ pick: { round: 'D-2026-10-20', slot: 0, signedAt: 1, ...p } }, RULES)
  assert.equal(ok({ side: 'RED', spreadBp: 10 }).ok, true)
  assert.equal(ok({ side: 0, spreadBp: -10 }).reason, 'side_mismatch')
  assert.equal(ok({ side: 1, spreadBp: 10 }).reason, 'side_mismatch')
  assert.equal(ok({ side: 1, spreadBp: 0 }).ok, true)
  assert.equal(ok({ side: 0, spreadBp: 2001 }).reason, 'bad_spread')
  assert.equal(ok({ side: 0, spreadBp: 1.5 }).reason, 'bad_spread')
  assert.equal(ok({ side: 2, spreadBp: 0 }).reason, 'bad_side')
  assert.equal(parsePick({ pick: { round: roundHex('ELECTION-2026'), side: 0, spreadBp: 0, slot: 0, signedAt: 1 } }, RULES).pick.round, 'ELECTION-2026')
  assert.equal(parsePick({ pick: { round: 'x y', side: 0, spreadBp: 0, slot: 0, signedAt: 1 } }, RULES).reason, 'bad_round')
})
