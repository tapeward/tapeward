import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { keccak256, encodeAbiParameters, getAddress } from 'viem'
import { TYPED, acct } from './helpers.mjs'
import { leafHash, buildTree, proofsOf, verifyProof, leafValues, LEAF_ENCODING } from '../score.mjs'
import { roundHex } from '../calendar.mjs'

test('leaf = CONTRACTS leaf (typed-data.json example)', () => {
  const v = TYPED.example.leafValue
  assert.deepEqual(LEAF_ENCODING, TYPED.leafEncoding)
  const p = { roundHex: v[0], picker: v[1], slot: v[2], side: v[3], spreadBp: v[4], signedAt: v[5] }
  assert.equal(leafHash(p), TYPED.example.leafHash)
  // by hand: keccak256(bytes.concat(keccak256(abi.encode(...))))
  const inner = keccak256(encodeAbiParameters(LEAF_ENCODING.map((type) => ({ type })), [v[0], v[1], v[2], v[3], v[4], BigInt(v[5])]))
  assert.equal(keccak256(inner), TYPED.example.leafHash)
})

test('root + proofs verify, and match OZ StandardMerkleTree', () => {
  const picks = Array.from({ length: 7 }, (_, i) => ({ roundHex: roundHex('D-2026-10-20'), picker: acct(i).address, slot: 0, side: i % 2, spreadBp: i % 2 ? -i * 10 : i * 10, signedAt: 1792500000 + i }))
  const tree = buildTree(picks)
  const oz = StandardMerkleTree.of(picks.map(leafValues), LEAF_ENCODING)
  assert.equal(tree.root, oz.root)
  const proofs = proofsOf(tree)
  for (const p of picks) {
    const leaf = leafHash(p)
    assert.ok(proofs.has(leaf))
    assert.ok(verifyProof(tree.root, leafValues(p), proofs.get(leaf)))
  }
  // order of input does not matter (OZ sorts leaves)
  assert.equal(buildTree([...picks].reverse()).root, tree.root)
  // a changed pick changes the root
  assert.notEqual(buildTree([{ ...picks[0], spreadBp: 11 }, ...picks.slice(1)]).root, tree.root)
  assert.equal(buildTree([]), null)
})
