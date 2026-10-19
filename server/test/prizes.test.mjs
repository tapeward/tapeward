import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { keccak256, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { makeApp, signPick, acct, nowS, PRIZE_CFG, quiet } from './helpers.mjs'
import { budgetFor, allocate, chooseAsset, pickWinners, createPrizes, usdToUnits } from '../prizes.mjs'
import { proofLine } from '../card.mjs'
import { openStore } from '../store.mjs'
import { fixedClock } from '../config.mjs'

const E18 = 10n ** 18n
test('budget math: daily 4 % (no prize below $1), election 40 %', () => {
  assert.deepEqual(budgetFor('daily', 100, PRIZE_CFG), { pct: 4, budgetUsd: 4, note: null })
  assert.equal(budgetFor('daily', 20, PRIZE_CFG).budgetUsd, 0)
  assert.match(budgetFor('daily', 20, PRIZE_CFG).note, /no prize today/)
  assert.equal(budgetFor('daily', 25, PRIZE_CFG).budgetUsd, 1)
  assert.equal(budgetFor('election', 20, PRIZE_CFG).budgetUsd, 8)
})

test('splits, unfilled places stay in the wallet, holder weight ×2', () => {
  const W = (n, weight = 1) => Array.from({ length: n }, (_, i) => ({ address: 'a' + i, weight }))
  assert.deepEqual(allocate(10, [50, 30, 20], W(3)).map((x) => x.usd), [5, 3, 2])
  assert.deepEqual(allocate(10, [50, 30, 20], W(2)).map((x) => x.usd), [5, 3])        // 3rd share stays
  const h = allocate(13, [50, 30, 20], [{ address: 'a', weight: 1 }, { address: 'b', weight: 2 }, { address: 'c', weight: 1 }])
  assert.deepEqual(h.map((x) => x.usd), [5, 6, 2])                                         // 13·50/130, 13·60/130, 13·20/130
  assert.ok(h.reduce((s, x) => s + x.usd, 0) <= 13)
  const e = allocate(100, PRIZE_CFG.election.split_pct, W(10))
  assert.deepEqual(e.map((x) => x.usd), [25, 18, 14, 11, 9, 7, 6, 4, 3, 3])
})

test('winners: desk excluded, ineligible skipped, board order (ties already by earlier signature)', () => {
  const rows = [{ address: 'desk', house: true }, { address: 'fresh' }, { address: 'x' }, { address: 'y' }, { address: 'z' }, { address: 'w' }]
  const w = pickWinners(rows, { n: 3, isDesk: (r) => r.house, isEligible: (r) => r.address !== 'fresh' })
  assert.deepEqual(w.map((r) => r.address), ['x', 'y', 'z'])
})

test('asset choice: winning basket token by largest holding, else ETH above the gas reserve, else nothing', () => {
  const tokens = [
    { symbol: 'TSLA', token: 'T', basket: 'RED', decimals: 18, price: 400, balance: E18 / 10n },        // $40
    { symbol: 'SPCX', token: 'S', basket: 'RED', decimals: 18, price: 150, balance: E18 },              // $150
    { symbol: 'AAPL', token: 'A', basket: 'BLUE', decimals: 18, price: 300, balance: E18 },             // $300
  ]
  const eth = { balance: E18 / 100n, price: 2400 }   // $24
  const reserveWei = 3n * 10n ** 14n
  let left = {}
  assert.equal(chooseAsset(100, { basket: 'RED', tokens, eth, left, reserveWei }).symbol, 'SPCX')
  assert.equal(chooseAsset(45, { basket: 'RED', tokens, eth, left, reserveWei }).symbol, 'SPCX')   // $50 left in SPCX
  assert.equal(chooseAsset(45, { basket: 'RED', tokens, eth, left, reserveWei }), null)            // SPCX $5, TSLA $40, ETH $24
  assert.equal(chooseAsset(30, { basket: 'RED', tokens, eth, left, reserveWei }).symbol, 'TSLA')
  left = {}
  const x = chooseAsset(10, { basket: null, tokens, eth, left, reserveWei })                       // spread 0 → ETH
  assert.equal(x.symbol, 'ETH'); assert.equal(x.amount, usdToUnits(10, 2400))
  assert.equal(chooseAsset(23.9, { basket: 'BLUE', tokens: [], eth, left: {}, reserveWei }), null)  // would eat the gas reserve
})

test('daily round prizes end to end (mock payments): budget at lock, eligibility at pick time, desk never wins, rollover, wallet/board/card', async () => {
  const W = PRIZE_CFG.wallet.toLowerCase()
  const users = [1, 2, 3, 4, 5].map(acct)
  const nonces = Object.fromEntries(users.map((u, i) => [u.address.toLowerCase(), i === 1 ? 0 : 5]))   // users[1] = fresh wallet
  const TSLA = PRIZE_CFG.tokens.find((t) => t.symbol === 'TSLA').token.toLowerCase()
  const AAPL = PRIZE_CFG.tokens.find((t) => t.symbol === 'AAPL').token.toLowerCase()
  const app = makeApp({ now: '2026-10-19T08:00:00Z', chainOpts: { nonces, ethBalances: { [W]: E18 / 100n }, tokenBalances: { [TSLA]: { [W]: E18 }, [AAPL]: { [W]: E18 } } } })
  await app.rounds.tick()
  const D = app.store.getRound('D-2026-10-19')
  app.clock.set('2026-10-19T09:00:00Z')
  // the same call for everyone except users[4] → ties broken by the earlier signature
  const picks = [[0, 0, 40], [1, 0, 40], [2, 0, 40], [3, 0, 40], [4, 1, -400]]
  for (const [i, side, sp] of picks) {
    app.clock.add(1000)
    const out = await app.picks.submit(await signPick(users[i], { round: D.id, side, spreadBp: sp, slot: 0, signedAt: nowS(app) }), { ip: 'p' + i })
    assert.ok(out.ok, out.error)
  }
  await new Promise((r) => setTimeout(r, 20))   // nonce lookups run after the receipt
  assert.equal(app.store.getPick(D.id, users[1].address, 0).nonce, 0)
  assert.equal(app.store.getPick(D.id, users[0].address, 0).nonce, 5)
  // picks close → final record; lock → budget frozen
  app.clock.set('2026-10-19T13:28:30Z'); await app.rounds.tick()
  app.clock.set('2026-10-19T13:30:05Z'); await app.rounds.tick(); await app.prizes.poll(); await app.prizes.tick()
  const b = app.store.getBudget(D.id)
  const w0 = await app.prizes.readWallet()
  assert.ok(b && Math.abs(b.valueUsd - Math.round(w0.valueUsd * 100) / 100) < 0.01)
  assert.ok(b.budgetUsd > 0 && Math.abs(b.budgetUsd - b.valueUsd * 0.04) < 0.01)
  // settle → plan + pay
  app.clock.set('2026-10-19T20:10:31Z'); await app.rounds.tick(); await app.prizes.tick()
  const board = await app.views.board(D.id)
  assert.equal(board.official, true)
  const pays = app.store.payoutsOf(D.id)
  assert.equal(pays.length, 3)
  const winners = pays.map((p) => p.address)
  assert.ok(!winners.includes(app.desk.address), 'desk never wins')
  assert.ok(!winners.includes(users[1].address), 'fresh wallet (nonce 0 at pick time) is not eligible')
  const ranked = board.rows.filter((r) => !r.house && r.address !== users[1].address).map((r) => r.address).slice(0, 3)
  assert.deepEqual(winners, ranked)
  assert.ok(pays.every((p) => p.status === 'mock' || p.status === 'rolled_over'))
  const basket = app.store.resultsOf(D.id)[0].spreadBp > 0 ? 'RED' : 'BLUE'
  for (const p of pays.filter((x) => x.status === 'mock')) assert.equal(p.symbol, basket === 'RED' ? 'TSLA' : 'AAPL')
  // idempotent: another tick plans/pays nothing new
  await app.prizes.tick()
  assert.equal(app.store.payoutsOf(D.id).length, 3)
  // API views
  const wl = await app.views.wallet(pays[0].address)
  assert.equal(wl.won[0].round, D.id); assert.ok(wl.totals.wonUsd > 0)
  const row = (await app.views.board(D.id)).rows.find((r) => r.address === pays[0].address)
  assert.equal(row.prize.place, 1)
  const st = await app.views.state()
  const rp = st.rounds.find((r) => r.id === D.id).prize
  assert.equal(rp.locked, true); assert.equal(rp.winners.length, 3); assert.deepEqual(rp.split, [50, 30, 20])
  const m = await app.api.cardModel(D.id, pays[0].address)
  assert.match(proofLine(m), /^won \$\d+\.\d\d in (TSLA|AAPL)/)
  const ov = app.prizes.overview()
  assert.equal(ov.wallet, PRIZE_CFG.wallet); assert.ok(ov.valueUsd > 0); assert.equal(ov.payouts.length, 3)
  app.stop()
})

test('rollover: payouts under $0.10 are not sent; a $1-$25 wallet gives no daily prize', async () => {
  const W = PRIZE_CFG.wallet.toLowerCase()
  const u = acct(31)
  const app = makeApp({ now: '2026-10-19T08:00:00Z', chainOpts: { nonces: { [u.address.toLowerCase()]: 3 }, ethBalances: { [W]: 10n ** 16n } } })   // $24 → 4 % = $0.96 < $1
  await app.rounds.tick()
  app.clock.set('2026-10-19T09:00:00Z')
  assert.ok((await app.picks.submit(await signPick(u, { round: 'D-2026-10-19', side: 0, spreadBp: 10, slot: 0, signedAt: nowS(app) }), { ip: 'r' })).ok)
  await new Promise((r) => setTimeout(r, 20))
  app.clock.set('2026-10-19T13:28:30Z'); await app.rounds.tick()
  app.clock.set('2026-10-19T13:30:05Z'); await app.rounds.tick(); await app.prizes.tick()
  assert.equal(app.store.getBudget('D-2026-10-19').budgetUsd, 0)
  app.clock.set('2026-10-19T20:10:31Z'); await app.rounds.tick(); await app.prizes.tick()
  assert.equal(app.store.payoutsOf('D-2026-10-19').length, 0)
  assert.equal((await app.views.state()).rounds.find((r) => r.id === 'D-2026-10-19').prize.noPrize, true)
  // allocation of a tiny budget → rolled over rows
  const tiny = allocate(0.25, [50, 30, 20], [{ address: 'a', weight: 1 }, { address: 'b', weight: 1 }])
  assert.deepEqual(tiny.map((x) => x.usd < PRIZE_CFG.min_payout_usd), [false, true])
  app.stop()
})

test('payments are crash-safe: never paid twice (sign → persist → broadcast; restart re-broadcasts the same tx)', async () => {
  const payer = privateKeyToAccount('0x' + 'ab'.repeat(32))
  const clock = fixedClock('2026-10-19T20:20:00Z')
  const store = openStore({ memory: true })
  let chainNonce = 7, crash = 'before-broadcast', signs = 0
  const sent = [], mined = new Map()
  const account = { address: payer.address, signTransaction: async (tx) => { signs++; return payer.signTransaction(tx) } }
  const pub = {
    async getTransactionCount() { return chainNonce },
    async estimateGas() { return 50_000n },
    async estimateFeesPerGas() { return { maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1n } },
    async sendRawTransaction({ serializedTransaction }) {
      if (crash === 'before-broadcast') { crash = null; throw new Error('process died') }
      sent.push(serializedTransaction)
      if (crash === 'after-broadcast') { crash = null; mined.set(keccak256(serializedTransaction), { status: 'success', blockNumber: 99n }); chainNonce++; throw new Error('process died') }
      return keccak256(serializedTransaction)
    },
    async getTransactionReceipt({ hash }) { const r = mined.get(hash); if (!r) throw new Error('not found'); return r },
    async waitForTransactionReceipt({ hash }) { const r = { status: 'success', blockNumber: 100n }; mined.set(hash, r); chainNonce++; return r },
  }
  const p = createPrizes({ store, chain: {}, clock, bus: new EventEmitter(), holder: {}, views: () => null, log: quiet, mode: 'chain', account, clients: { pub }, logs: null, cfg: () => ({ ...PRIZE_CFG, wallet: payer.address }) })
  store.putPayout({ round: 'D-X', rank: 1, address: acct(1).address, weight: 1, usd: 5, token: 'ETH', symbol: 'ETH', amount: (E18 / 1000n).toString(), status: 'planned' }, clock())
  // 1) crash between "signed" and the broadcast
  await assert.rejects(p.sendOne(store.payoutsOpen()[0]), /process died/)
  let row = store.payoutsOf('D-X')[0]
  assert.equal(row.status, 'signed'); assert.equal(row.nonce, 7); assert.ok(row.raw && row.tx === keccak256(row.raw))
  // restart: same raw tx re-broadcast, no new signature
  await p.send()
  assert.equal(signs, 1); assert.deepEqual(sent, [row.raw])
  assert.equal(store.payoutsOf('D-X')[0].status, 'sent')
  mined.set(row.tx, { status: 'success', blockNumber: 101n }); chainNonce = 8
  await p.send()
  assert.equal(store.payoutsOf('D-X')[0].status, 'confirmed')
  await p.send()
  assert.equal(sent.length, 1, 'a confirmed payout is never sent again')
  assert.equal(parseTransaction(row.raw).value, E18 / 1000n)

  // 2) mined, then crash before it was recorded → restart only confirms
  store.putPayout({ round: 'D-Y', rank: 1, address: acct(2).address, weight: 1, usd: 5, token: PRIZE_CFG.tokens[0].token, symbol: 'TSLA', amount: E18.toString(), status: 'planned' }, clock())
  crash = 'after-broadcast'
  await assert.rejects(p.sendOne(store.payoutsOpen()[0]), /process died/)
  row = store.payoutsOf('D-Y')[0]
  assert.equal(row.status, 'signed')
  assert.equal(parseTransaction(row.raw).to.toLowerCase(), PRIZE_CFG.tokens[0].token.toLowerCase())   // ERC-20 transfer call
  await p.send()
  assert.equal(store.payoutsOf('D-Y')[0].status, 'confirmed')
  assert.equal(sent.filter((x) => x === row.raw).length, 1)

  // 3) our nonce was taken by another tx and ours never mined → re-planned only after two checks ≥ 2 min apart
  store.putPayout({ round: 'D-Z', rank: 1, address: acct(3).address, weight: 1, usd: 5, token: 'ETH', symbol: 'ETH', amount: '1000', status: 'planned' }, clock())
  crash = 'before-broadcast'
  await assert.rejects(p.sendOne(store.payoutsOpen()[0]), /process died/)
  chainNonce += 1   // someone else used it
  await p.send()
  assert.match(store.payoutsOf('D-Z')[0].error, /^nonce-used-at:/)
  assert.equal(store.payoutsOf('D-Z')[0].status, 'signed')
  clock.add(130_000)
  await p.send()   // reset → planned
  assert.equal(store.payoutsOf('D-Z')[0].status, 'planned')
  await p.send()   // re-signed with a fresh nonce and sent
  row = store.payoutsOf('D-Z')[0]
  assert.equal(row.status, 'confirmed'); assert.equal(row.nonce, chainNonce - 1)
})

test('mock mode pays into SQLite only; wrong key or no key never sends', async () => {
  const store = openStore({ memory: true })
  const clock = fixedClock('2026-10-19T20:20:00Z')
  const mk = (mode, account) => createPrizes({ store, chain: {}, clock, bus: null, holder: {}, views: () => null, log: quiet, mode, account, clients: { pub: {} }, logs: null })
  store.putPayout({ round: 'R', rank: 1, address: acct(1).address, weight: 1, usd: 1, token: 'ETH', symbol: 'ETH', amount: '1', status: 'planned' }, clock())
  await mk('chain', null).send()
  assert.equal(store.payoutsOf('R')[0].status, 'planned'); assert.match(store.payoutsOf('R')[0].error, /no prize key/)
  await mk('chain', acct(5)).send()
  assert.match(store.payoutsOf('R')[0].error, /not the prize wallet/)
  await mk('mock', null).send()
  assert.equal(store.payoutsOf('R')[0].status, 'mock'); assert.match(store.payoutsOf('R')[0].tx, /^mock-0x/)
})
