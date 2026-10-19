// Chain-mode check against the real RaceBook bytecode on an anvil fork of Robinhood Chain mainnet (local only, no real tx).
//   npm run fork-test     (needs anvil + network; contracts/out/RaceBook.sol/RaceBook.json from `forge build`)
// 1. deploy RaceBook (feeds from feeds.json) · 2. a round opening now: openRound → desk pick + user picks → hourly anchor → final anchor
// 3. jump past the score time + SETTLE_DELAY → settle with round ids from chain.findRoundAt → readResult
// 4. verify.mjs against the fork = the server board · 5. settle a real past window (D-2026-10-16) with real Chainlink rounds
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { createPublicClient, createTestClient, createWalletClient, http, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const PORT = 8547, URL_ = `http://127.0.0.1:${PORT}`
const FORK = process.env.FORK_URL || 'https://robinhood-rpc.publicnode.com'
// anvil default test keys (public, never funded on any real chain)
const K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', K1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const poster = privateKeyToAccount(K0), owner = privateKeyToAccount(K1)
process.env.RACEBOOK = '0x0000000000000000000000000000000000000001'   // replaced after deploy
process.env.RPC_URL = URL_

const anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent', '--no-rate-limit', '--hardfork', 'cancun'], { stdio: 'ignore' })
const stop = () => { try { anvil.kill() } catch {} }
process.on('exit', stop)
const chainDef = { id: 4663, name: 'rc-fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [URL_] } } }
const pub = createPublicClient({ chain: chainDef, transport: http(URL_) })
for (let i = 0; i < 60; i++) { try { await pub.getBlockNumber(); break } catch { await new Promise((r) => setTimeout(r, 500)) } }
const test = createTestClient({ chain: chainDef, mode: 'anvil', transport: http(URL_) })
const wallet = createWalletClient({ chain: chainDef, account: poster, transport: http(URL_) })

const { openStore } = await import('../store.mjs')
const { createChain } = await import('../chain.mjs')
const { createRpc } = await import('../rpc.mjs')
const { fixedClock, feeds } = await import('../config.mjs')
const { createTapeward } = await import('../app.mjs')
const { verifyRound, ABI } = await import('../verify.mjs')
const { signPick, acct, RULES } = await import('./helpers.mjs')
delete process.env.NO_NETWORK   // helpers sets it; this script needs the fork

const art = JSON.parse(readFileSync(fileURLToPath(new URL('../../contracts/out/RaceBook.sol/RaceBook.json', import.meta.url)), 'utf8'))
const F = feeds()
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [owner.address, poster.address, F.filter((f) => f.basket === 'RED').map((f) => f.proxy), F.filter((f) => f.basket === 'BLUE').map((f) => f.proxy), F.find((f) => f.basket === 'REF').proxy] })
const rc = await pub.waitForTransactionReceipt({ hash })
process.env.RACEBOOK = rc.contractAddress
console.log(`RaceBook on fork ${rc.contractAddress} (deploy gas ${rc.gasUsed})`)

const blockTs = async () => Number((await pub.getBlock()).timestamp) * 1000
const clock = fixedClock(await blockTs())
const quiet = { log: (m) => console.log('  ' + m), error: (m) => console.log('  ! ' + m) }
const app = createTapeward({ store: openStore({ memory: true }), chain: createChain({ reads: createRpc([URL_]) }), clock, bus: new EventEmitter(), log: quiet, rules: () => RULES,
  token: () => ({ name: 'TAPEWARD', ca: '0x0000000000000000000000000000000000000000', holder_min: 0 }), bookOpts: { mode: 'chain', account: poster, rpcUrl: URL_ }, kalshi: null, deskAccount: poster })
assert.equal(app.book.canSend(), true)

// a round that opens now
const now = clock()
const R = { id: 'T-FORK-1', kind: 'daily', label: 'fork test', day: null, opensAt: now - 1000, picksClose: now + 3_000_000, lockTime: now + 3_120_000, scoreTimes: [now + 3_600_000], scoreLabels: ['Close'] }
app.store.putRound(R, now)
await app.rounds.tick()   // openRound + desk pick
let r = app.store.getRound(R.id)
assert.equal(r.openStatus, 'confirmed', r.openError)
console.log(`openRound ${r.openTx} · desk ${r.desk?.side} ${r.desk?.spreadBp}`)
assert.equal((await app.book.readRound(R.id)).anchorCount, 1, 'desk pick recorded at once')
const users = [1, 2, 3].map(acct)
for (const [i, a] of users.entries()) {
  const b = await signPick(a, { round: R.id, side: i % 2, spreadBp: i % 2 ? -20 * i : 30 * i, slot: 0, signedAt: Math.floor(clock() / 1000) })
  const out = await app.picks.submit(b, { ip: 'fork' })
  assert.ok(out.ok, out.error)
}
const a1 = await app.rounds.anchorRound(app.store.getRound(R.id), 'hourly')
assert.equal(a1.status, 'confirmed')
const rv = await app.book.readRound(R.id)
assert.equal(rv.anchorCount, 2); assert.equal(rv.count, 4)
console.log(`anchor #1 ${a1.tx} · on chain count ${rv.count}`)
// picks close → final anchor (same leaves → marked final, no tx); a new pick first so a real final anchor is sent
await test.increaseTime({ seconds: 2_400 }); await test.mine({ blocks: 1 })
clock.set(await blockTs())
const late = await signPick(acct(9), { round: R.id, side: 0, spreadBp: 5, slot: 0, signedAt: Math.floor(clock() / 1000) })
{ const o = await app.picks.submit(late, { ip: 'fork' }); assert.ok(o.ok, JSON.stringify(o)) }
await test.increaseTime({ seconds: 660 }); await test.mine({ blocks: 1 })
clock.set(await blockTs())
assert.ok(clock() >= R.picksClose && clock() < R.lockTime)
await app.rounds.tick()
const fin = app.store.anchorsOf(R.id).at(-1)
assert.equal(fin.final, true); assert.equal(fin.status, 'confirmed'); assert.equal(fin.n, 3)
console.log(`final anchor #${fin.n} ${fin.tx} (count ${fin.count})`)
// after lock the contract refuses
await test.increaseTime({ seconds: 200 }); await test.mine({ blocks: 1 }); clock.set(await blockTs())
await assert.rejects(app.book.anchor(app.store.getRound(R.id), fin.root, fin.count, 'x'), /AnchorAfterLock/)
// settle: too early, then OK
await assert.rejects(app.book.settle(app.store.getRound(R.id), 0, [], []), /TooEarly|BadRoundsLength/)
await test.increaseTime({ seconds: 3_600 }); await test.mine({ blocks: 1 }); clock.set(await blockTs())
await app.rounds.tick()
const res = app.store.resultsOf(R.id)[0]
assert.equal(res.status, 'confirmed', res.error)
console.log(`settle ${res.tx} · RED ${res.redBp} BLUE ${res.blueBp} SPY ${res.refBp} spread ${res.spreadBp}`)
const board = await app.views.board(R.id)
assert.equal(board.official, true)
// verify.mjs on the fork
const doc = JSON.parse(JSON.stringify(app.views.picksDoc(R.id)))
const rep = await verifyRound({ round: R.id, picksUrl: 'local', racebook: rc.contractAddress, fetchJson: async () => doc,
  read: ({ address, abi = ABI, functionName, args }) => pub.readContract({ address, abi, functionName, args }), log: (m) => console.log('  verify: ' + m) })
assert.deepEqual(rep.errors, [])
assert.deepEqual(rep.results[0].board.map((x) => [x.picker, x.best.score]), board.rows.map((x) => [x.address, x.score]))
console.log(`verify.mjs ✓ (${rep.leaves} leaves, ${board.rows.length} board rows)`)

// a real past window: Fri 16 Oct 2026 13:30 → 20:00 UTC
const P = { id: 'D-2026-10-16', kind: 'daily', label: 'past', day: '2026-10-16', opensAt: Date.parse('2026-10-15T20:00:00Z'), picksClose: Date.parse('2026-10-16T13:28:00Z'), lockTime: Date.parse('2026-10-16T13:30:00Z'), scoreTimes: [Date.parse('2026-10-16T20:00:00Z')], scoreLabels: ['Close'] }
app.store.putRound(P, clock())
const op = await app.book.openRound(P); app.store.setOpen(P.id, op.status, { tx: op.tx, at: clock() })
await app.rounds.settle()
const pr = app.store.resultsOf(P.id)[0]
assert.equal(pr.status, 'confirmed', pr.error)
const onchain = await app.book.readResult(P.id, 0)
assert.equal(onchain.spreadBp, pr.spreadBp)
console.log(`past window D-2026-10-16 settled with real Chainlink rounds: RED ${pr.redBp} bp · BLUE ${pr.blueBp} bp · SPY ${pr.refBp} bp · spread ${pr.spreadBp} bp · gas tx ${pr.tx}`)
const gas = async (h) => (await pub.getTransactionReceipt({ hash: h })).gasUsed
console.log(`gas: openRound ${await gas(r.openTx)} · anchor ${await gas(a1.tx)} · settle ${await gas(res.tx)} · settle(real) ${await gas(pr.tx)}`)
console.log('✓ fork test passed')
app.stop(); stop(); process.exit(0)
