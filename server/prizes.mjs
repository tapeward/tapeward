// Prizes (BRIEF change log 19-10-2026, numbers in server/prizes.json).
//   wallet value  = ETH × Chainlink ETH/USD + Σ known RC stock tokens × their Chainlink feed (unknown tokens ignored)
//   budget        = daily 4 % (no prize below $1) / ELECTION-2026 40 % of that value, frozen at lock (prize_budgets)
//   winners       = the official board (best slot per wallet, ties → earlier signature) after the settle that makes it official,
//                   house desk excluded, only wallets whose nonce was ≥ 1 when the pick came in (stored at receipt), split 50/30/20
//                   (election 25/18/14/11/9/7/6/4/3/3). After T0 holders weigh ×2: usd_i = budget × split_i·w_i / Σ split_k·w_k
//                   (unfilled places keep weight 1, so their share stays in the wallet). Payouts < $0.10 roll over (not sent).
//   asset         = the winning basket's tokens held by the wallet, largest USD holding first, if it covers the payout; else ETH
//                   (keeping gas_reserve_eth); else skipped (stays in the wallet).
//   payment       = plain transfers from PRIZE_PK (env or /etc/tapeward/prize.env), one at a time. Idempotent: the row is written as
//                   "planned" first; before broadcasting, the signed raw tx + its hash + nonce are stored ("signed"); after a crash the
//                   same raw tx is re-broadcast (same nonce → can never pay twice) or, once its receipt exists, marked confirmed. Only
//                   when the nonce was consumed by another tx and our hash has no receipt (seen twice ≥ 2 min apart) is the row re-planned.
//   CHAIN_MODE=mock  → payouts are recorded in SQLite only ("mock-0x…").
// Inbound top-ups: ERC-20 Transfer logs into the wallet for the known tokens (LOG_RPC_URLS, default the official RC RPC, which allows
// address-filtered ranges) + native ETH from balance increases between polls (tx not indexed for native).
import { readFileSync } from 'node:fs'
import { createPublicClient, http, keccak256, encodeFunctionData, getAddress, parseAbi, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SERVER_DIR, readJson, parseEnvFile, iso, link, gateOn, token as tokenOf, chainMode, PUBLICNODE } from './config.mjs'
import { createRpc, hexToBig } from './rpc.mjs'
import { robinhood, errName } from './book.mjs'

export const prizeConfig = () => readJson(process.env.PRIZES_JSON || SERVER_DIR + 'prizes.json')
const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const E18 = 10n ** 18n
const okStatus = (s) => s === 'confirmed' || s === 'mock'
const r2 = (x) => Math.round(x * 100) / 100
const r4 = (x) => Math.floor(x * 10_000) / 10_000
/** USD (number) → token units (BigInt) at price (number), floor */
export const usdToUnits = (usd, price, decimals = 18) => (BigInt(Math.floor((usd / price) * 1e12)) * 10n ** BigInt(decimals)) / 10n ** 12n
export const unitsToNum = (u, decimals = 18) => Number(BigInt(u)) / 10 ** decimals

let cachedKey
export function loadPrizeAccount(env = process.env) {
  if (cachedKey !== undefined && env === process.env) return cachedKey
  let key = env.PRIZE_PK || null
  if (!key) { try { key = parseEnvFile(readFileSync(env.PRIZE_ENV_FILE || '/etc/tapeward/prize.env', 'utf8')).PRIZE_PK || null } catch {} }
  let acct = null
  if (key) {
    const k = key.startsWith('0x') ? key : '0x' + key
    if (/^0x[0-9a-fA-F]{64}$/.test(k)) acct = privateKeyToAccount(k)
    else console.error('prizes: PRIZE_PK is malformed (value not shown)')
  }
  if (env === process.env) cachedKey = acct
  return acct
}

// ───────────────────────────── pure parts (tested)
/** budget of a round from the wallet value at lock */
export function budgetFor(kind, valueUsd, cfg) {
  const c = kind === 'election' ? cfg.election : cfg.daily
  const raw = (valueUsd * c.budget_pct) / 100
  if (kind !== 'election' && raw < (cfg.daily.min_budget_usd ?? 1)) return { pct: c.budget_pct, budgetUsd: 0, note: 'no prize today (budget below $1)' }
  return { pct: c.budget_pct, budgetUsd: r4(raw), note: null }
}
/** top N eligible board rows (desk excluded); rows are already ranked */
export function pickWinners(rows, { n, isDesk, isEligible }) {
  const out = []
  for (const r of rows) {
    if (out.length >= n) break
    if (isDesk(r) || !isEligible(r)) continue
    out.push(r)
  }
  return out
}
/** usd per winner: budget × split_i·w_i / Σ split_k·w_k (unfilled places weigh 1, their share stays in the wallet) */
export function allocate(budgetUsd, split, winners) {
  const den = split.reduce((s, p, i) => s + p * (winners[i] ? winners[i].weight : 1), 0)
  return winners.map((w, i) => ({ ...w, place: i + 1, usd: r4((budgetUsd * split[i] * w.weight) / den) }))
}
/** asset for one payout: winning basket tokens by USD holding desc, else ETH above the gas reserve; mutates `left` (remaining units) */
export function chooseAsset(usd, { basket, tokens, eth, left, reserveWei }) {
  const cands = tokens.filter((t) => basket && t.basket === basket && t.price > 0).map((t) => ({ ...t, leftUnits: left[t.token] ?? t.balance }))
    .sort((a, b) => unitsToNum(b.leftUnits, b.decimals) * b.price - unitsToNum(a.leftUnits, a.decimals) * a.price)
  for (const t of cands) {
    const amount = usdToUnits(usd, t.price, t.decimals)
    if (amount > 0n && amount <= t.leftUnits) { left[t.token] = t.leftUnits - amount; return { token: t.token, symbol: t.symbol, amount, price: t.price } }
  }
  if (eth?.price > 0) {
    const amount = usdToUnits(usd, eth.price, 18)
    const avail = (left.ETH ?? eth.balance) - reserveWei
    if (amount > 0n && amount <= avail) { left.ETH = (left.ETH ?? eth.balance) - amount; return { token: 'ETH', symbol: 'ETH', amount, price: eth.price } }
  }
  return null
}

export function createPrizes({ store, chain, clock, bus, holder, views, token = tokenOf, log = console, mode = chainMode(), cfg = prizeConfig, account, clients, logs, rpcUrl = process.env.WRITE_RPC_URL || process.env.RPC_URL || PUBLICNODE } = {}) {
  const C = () => cfg()
  const acct = () => (account === undefined ? loadPrizeAccount() : account)
  const isMock = () => mode === 'mock'
  const wallet = () => getAddress(C().wallet)
  let pub
  const getPub = () => clients?.pub || (pub ||= createPublicClient({ chain: robinhood(rpcUrl), transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) }))
  const logRpc = logs === undefined ? createRpc(String(process.env.LOG_RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com').split(',').map((s) => s.trim()).filter(Boolean), { timeoutMs: 30_000 }) : logs
  let last = { at: null, ok: null, error: null }

  /** live wallet: ETH + known tokens with Chainlink prices */
  async function readWallet() {
    const c = C()
    const feeds = [{ symbol: 'ETH', proxy: c.eth_usd_feed, decimals: 8 }, ...c.tokens.map((t) => ({ symbol: t.symbol, proxy: t.feed, decimals: 8 }))]
    const [prices, h] = await Promise.all([chain.latestRounds(feeds), chain.holdings(c.tokens.map((t) => t.token), wallet())])
    const px = (i) => prices[i]?.price ?? null
    const eth = { symbol: 'ETH', balance: h.eth, price: px(0), usd: px(0) ? unitsToNum(h.eth) * px(0) : 0 }
    const tokens = c.tokens.map((t, i) => ({ ...t, balance: h.tokens[i], price: px(i + 1), usd: px(i + 1) ? unitsToNum(h.tokens[i], t.decimals) * px(i + 1) : 0 }))
    return { at: clock(), block: h.block, eth, tokens, valueUsd: eth.usd + tokens.reduce((s, t) => s + t.usd, 0) }
  }
  const jsonWallet = (w) => w && ({ at: iso(w.at), block: w.block, valueUsd: r2(w.valueUsd),
    eth: { balance: w.eth.balance.toString(), amount: unitsToNum(w.eth.balance), price: w.eth.price, usd: r2(w.eth.usd) },
    holdings: w.tokens.filter((t) => t.balance > 0n).map((t) => ({ symbol: t.symbol, token: t.token, basket: t.basket, balance: t.balance.toString(), amount: unitsToNum(t.balance, t.decimals), price: t.price, usd: r2(t.usd) })) })

  // ───────────────────────────── polling + top-ups
  async function poll() {
    try {
      const w = await readWallet()
      const prev = store.kv('prize:eth')
      if (prev && w.eth.balance > BigInt(prev.balance)) {
        const d = w.eth.balance - BigInt(prev.balance)
        store.putTopup({ id: `eth:${w.block}:${d}`, kind: 'native', token: null, symbol: 'ETH', amount: d.toString(), usd: w.eth.price ? r2(unitsToNum(d) * w.eth.price) : null, block: w.block, at: clock() })
        bus?.emit('prize_topup', { symbol: 'ETH', amount: d.toString() })
      }
      store.setKv('prize:eth', { balance: w.eth.balance.toString(), block: w.block })
      store.setKv('prize:wallet', jsonWallet(w))
      last = { at: clock(), ok: true, error: null }
      return w
    } catch (e) { last = { at: clock(), ok: false, error: e.message }; return null }
  }
  async function scanLogs() {
    if (!logRpc) return 0
    const c = C()
    try {
      const top = Number(hexToBig(await logRpc.rpc('eth_blockNumber')))
      let from = store.kv('prize:logBlock') ?? (c.from_block ?? 92451000)
      let n = 0
      while (from <= top) {
        const to = Math.min(top, from + 500_000)
        const ls = await logRpc.rpc('eth_getLogs', [{ address: c.tokens.map((t) => t.token), topics: [TRANSFER, null, '0x' + wallet().slice(2).toLowerCase().padStart(64, '0')], fromBlock: toHex(from), toBlock: toHex(to) }])
        for (const l of ls || []) {
          const t = c.tokens.find((x) => x.token.toLowerCase() === l.address.toLowerCase())
          const amount = hexToBig(l.data)
          const price = store.kv('prize:wallet')?.holdings?.find((h) => h.symbol === t?.symbol)?.price ?? null
          if (store.putTopup({ id: `${l.transactionHash}:${Number(hexToBig(l.logIndex))}`, kind: 'erc20', token: l.address, symbol: t?.symbol ?? null, amount: amount.toString(),
            usd: price ? r2(unitsToNum(amount) * price) : null, from: getAddress('0x' + l.topics[1].slice(-40)), tx: l.transactionHash, block: Number(hexToBig(l.blockNumber)), at: clock() })) n++
        }
        store.setKv('prize:logBlock', to + 1)
        from = to + 1
      }
      return n
    } catch (e) { log.error?.(`prizes: top-up logs: ${e.message}`); return -1 }
  }

  // ───────────────────────────── budgets at lock
  async function lockBudgets() {
    const now = clock()
    for (const r of store.rounds()) {
      if (now < r.lockTime || store.getBudget(r.id)) continue
      if (store.resultsOf(r.id).some((x) => okStatus(x.status)) && now - r.lockTime > 6 * 3_600_000) continue   // round settled before prizes existed
      const w = await readWallet().catch((e) => { log.error?.(`prizes: wallet read at lock ${r.id}: ${e.message}`); return null })
      if (!w) continue
      const b = budgetFor(r.kind, w.valueUsd, C())
      const late = now - r.lockTime > 120_000 ? `read ${Math.round((now - r.lockTime) / 60_000)} min after lock` : null
      store.putBudget({ round: r.id, valueUsd: r2(w.valueUsd), budgetUsd: b.budgetUsd, pct: b.pct, holdings: jsonWallet(w), at: now, note: [b.note, late].filter(Boolean).join('; ') || null })
      log.log?.(`prizes: ${r.id} budget $${b.budgetUsd} (${b.pct} % of $${r2(w.valueUsd)})${b.note ? ' · ' + b.note : ''}`)
    }
  }

  // ───────────────────────────── eligibility (nonce at pick time)
  async function checkNonce(round, picker, slot) {
    try { const n = await chain.txCount(picker); store.setNonce(round, picker, slot, n); return n } catch { return null }
  }
  bus?.on('pick', (p) => { if (!p.trusted) checkNonce(p.round, p.picker, p.slot) })

  // ───────────────────────────── plan winners after the official settle
  async function plan() {
    const c = C()
    for (const r of store.rounds()) {
      const idx = r.kind === 'election' ? c.election.score_index : 0
      const res = store.resultsOf(r.id).find((x) => x.idx === idx && okStatus(x.status))
      const b = store.getBudget(r.id)
      if (!res || !b || store.kv(`prize:planned:${r.id}`)) continue
      const board = await views().board(r.id, idx)
      if (!board?.official) continue
      const split = r.kind === 'election' ? c.election.split_pct : c.daily.split_pct
      const deskAddr = r.desk?.address?.toLowerCase()
      const picks = store.picksOf(r.id)
      const nonceOf = async (row) => {
        const p = picks.find((x) => x.picker === row.address && x.slot === row.slot) || picks.find((x) => x.picker === row.address)
        if (p?.nonce != null) return p.nonce
        return p ? checkNonce(r.id, p.picker, p.slot) : null
      }
      const minNonce = c.min_nonce ?? 1
      const winners = []
      for (const row of board.rows) {   // same rule as pickWinners(), with the nonce looked up lazily
        if (winners.length >= split.length) break
        if (row.house || row.address.toLowerCase() === deskAddr) continue
        if (((await nonceOf(row)) ?? 0) < minNonce) continue
        winners.push(row)
      }
      const weighted = []
      for (const w of winners) {
        let weight = 1
        if (gateOn(token())) { const h = await holder.status(w.address, { fresh: true }); if (h.holder) weight = c.holder_weight ?? 2 }
        weighted.push({ address: w.address, score: w.score, rank: w.rank, weight })
      }
      const alloc = b.budgetUsd > 0 ? allocate(b.budgetUsd, split, weighted) : []
      // assets at today's prices; winning basket = sign of the official spread
      const basket = res.spreadBp > 0 ? 'RED' : res.spreadBp < 0 ? 'BLUE' : null
      const w = alloc.length ? await readWallet().catch(() => null) : null
      const left = {}
      const reserveWei = BigInt(Math.round((c.gas_reserve_eth ?? 0) * 1e18))
      const now = clock()
      for (const a of alloc) {
        const row = { round: r.id, rank: a.place, address: a.address, score: a.score, weight: a.weight, usd: a.usd }
        if (a.usd < (c.min_payout_usd ?? 0.1)) { store.putPayout({ ...row, status: 'rolled_over' }, now); continue }
        const asset = w ? chooseAsset(a.usd, { basket, tokens: w.tokens, eth: w.eth, left, reserveWei }) : null
        if (!asset) { store.putPayout({ ...row, status: 'skipped' }, now); store.setPayout(r.id, a.place, 'skipped', { error: w ? 'prize wallet cannot cover it (stays for the next round)' : 'wallet read failed' }, now); continue }
        store.putPayout({ ...row, token: asset.token, symbol: asset.symbol, amount: asset.amount.toString(), status: 'planned' }, now)
      }
      store.setKv(`prize:planned:${r.id}`, { at: now, winners: alloc.length, basket })
      log.log?.(`prizes: ${r.id} planned ${alloc.length} payouts (budget $${b.budgetUsd}, basket ${basket || 'none → ETH'})`)
      bus?.emit('prize_planned', { round: r.id })
    }
  }

  // ───────────────────────────── send (one at a time, crash-safe)
  async function txFor(p, nonce) {
    const P = getPub()
    const to = p.token === 'ETH' ? getAddress(p.address) : getAddress(p.token)
    const value = p.token === 'ETH' ? BigInt(p.amount) : 0n
    const data = p.token === 'ETH' ? undefined : encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [getAddress(p.address), BigInt(p.amount)] })
    const gas = await P.estimateGas({ account: acct().address, to, value, data })
    const fees = await P.estimateFeesPerGas()
    return { chainId: 4663, type: 'eip1559', to, value, data, nonce, gas: (gas * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
  }
  async function sendOne(p) {
    const now = clock()
    if (isMock()) { store.setPayout(p.round, p.rank, 'mock', { tx: 'mock-' + keccak256(toHex(`payout|${p.round}|${p.rank}|${p.address}`)), error: null }, now); return 'mock' }
    const a = acct()
    if (!a) { store.setPayout(p.round, p.rank, p.status, { error: 'no prize key (PRIZE_PK)' }, now); return 'nokey' }
    if (getAddress(a.address) !== wallet()) { store.setPayout(p.round, p.rank, p.status, { error: 'PRIZE_PK is not the prize wallet' }, now); return 'nokey' }
    const P = getPub()
    if (p.status === 'signed' || p.status === 'sent') {
      const rc = await P.getTransactionReceipt({ hash: p.tx }).catch(() => null)
      if (rc) { store.setPayout(p.round, p.rank, rc.status === 'success' ? 'confirmed' : 'failed', { block: Number(rc.blockNumber), error: rc.status === 'success' ? null : 'reverted' }, now); return 'done' }
      const used = await P.getTransactionCount({ address: a.address, blockTag: 'latest' })
      if (used > p.nonce) {
        const seen = /^nonce-used-at:(\d+)$/.exec(p.error || '')
        if (seen && now - Number(seen[1]) >= 120_000) { store.resetPayout(p.round, p.rank, 're-planned: nonce used by another tx, ours never mined', now); return 'reset' }
        if (!seen) store.setPayout(p.round, p.rank, p.status, { error: `nonce-used-at:${now}` }, now)
        return 'wait'
      }
      try { await P.sendRawTransaction({ serializedTransaction: p.raw }) } catch (e) { if (!/known|underpriced|nonce too low/i.test(e.message)) log.error?.(`prizes: rebroadcast ${p.round}#${p.rank}: ${errName(e)}`) }
      store.setPayout(p.round, p.rank, 'sent', { error: null }, now)
      return 'sent'
    }
    // planned → sign → persist → broadcast
    const nonce = await P.getTransactionCount({ address: a.address, blockTag: 'pending' })
    const tx = await txFor(p, nonce)
    const raw = await a.signTransaction(tx)
    const hash = keccak256(raw)
    store.setPayout(p.round, p.rank, 'signed', { nonce, raw, tx: hash, error: null }, now)
    await P.sendRawTransaction({ serializedTransaction: raw })
    store.setPayout(p.round, p.rank, 'sent', { error: null }, now)
    const rc = await P.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 2_000 }).catch(() => null)
    if (rc) store.setPayout(p.round, p.rank, rc.status === 'success' ? 'confirmed' : 'failed', { block: Number(rc.blockNumber), error: rc.status === 'success' ? null : 'reverted' }, clock())
    log.log?.(`prizes: paid ${p.round} #${p.rank} ${p.address} ${p.symbol} $${p.usd} → ${hash}${rc ? ' ' + rc.status : ' (pending)'}`)
    if (rc?.status === 'success') bus?.emit('prize_paid', { round: p.round, rank: p.rank, tx: hash })
    return rc ? 'done' : 'sent'
  }
  let sending = false
  async function send() {
    if (sending) return
    sending = true
    try {
      for (const p of store.payoutsOpen()) {
        try { const r = await sendOne(p); if (r === 'nokey' || r === 'wait') break } catch (e) { store.setPayout(p.round, p.rank, p.status, { error: errName(e) }, clock()); log.error?.(`prizes: ${p.round}#${p.rank}: ${errName(e)}`); break }
      }
    } finally { sending = false }
  }

  async function tick() {
    await lockBudgets()
    await plan()
    await send()
  }

  // ───────────────────────────── views
  const payoutView = (p) => ({ round: p.round, rank: p.rank, address: p.address, score: p.score, weight: p.weight, usd: r2(p.usd), token: p.token, symbol: p.symbol,
    amount: p.amount != null && p.symbol ? unitsToNum(p.amount, 18) : null, status: p.status, tx: ['confirmed', 'mock', 'sent', 'failed'].includes(p.status) ? p.tx : null, link: ['confirmed', 'sent'].includes(p.status) ? link.tx(p.tx) : null,
    note: p.status === 'rolled_over' ? 'under $0.10: stays in the prize wallet for the next round' : p.status === 'skipped' ? 'the prize wallet could not cover it: stays for the next round' : null })
  /** prize block of one round for /api/state, /api/round/:id */
  function roundPrize(r) {
    const c = C()
    const kindCfg = r.kind === 'election' ? c.election : c.daily
    const b = store.getBudget(r.id)
    const cur = store.kv('prize:wallet')
    const est = !b && cur ? budgetFor(r.kind, cur.valueUsd, c) : null
    const pays = store.payoutsOf(r.id).map(payoutView)
    const planned = store.kv(`prize:planned:${r.id}`)
    return {
      split: kindCfg.split_pct, pct: kindCfg.budget_pct, locked: !!b, budgetUsd: b ? b.budgetUsd : null, valueUsdAtLock: b ? b.valueUsd : null, lockedAt: b ? iso(b.at) : null,
      estimateUsd: est ? est.budgetUsd : null, noPrize: b ? b.budgetUsd === 0 : est ? est.budgetUsd === 0 : null, note: b?.note ?? est?.note ?? null,
      paidAfter: r.kind === 'election' ? r.scoreLabels[c.election.score_index] : r.scoreLabels[0], decided: !!planned, winners: pays,
    }
  }
  function wonBy(address) { return store.payoutsOfAddr(getAddress(address)).map(payoutView) }
  function overview() {
    const c = C()
    const w = store.kv('prize:wallet')
    const pays = store.payouts(500).map(payoutView)
    return {
      wallet: wallet(), link: link.address(wallet()), valueUsd: w?.valueUsd ?? null, readAt: w?.at ?? null, block: w?.block ?? null, eth: w?.eth ?? null, holdings: w?.holdings ?? [],
      topups: store.topups(200).map((t) => ({ kind: t.kind, symbol: t.symbol, token: t.token, amount: t.amount != null ? unitsToNum(t.amount, 18) : null, usd: t.usd, from: t.from, tx: t.tx, link: t.tx ? link.tx(t.tx) : null, block: t.block, at: iso(t.at),
        ...(t.kind === 'native' ? { note: 'detected from the wallet balance (native transfer)' } : {}) })),
      budgets: {
        daily: { pct: c.daily.budget_pct, minUsd: c.daily.min_budget_usd, split: c.daily.split_pct, estimateUsd: w ? budgetFor('daily', w.valueUsd, c).budgetUsd : null },
        election: { pct: c.election.budget_pct, split: c.election.split_pct, estimateUsd: w ? budgetFor('election', w.valueUsd, c).budgetUsd : null, locked: store.getBudget('ELECTION-2026')?.budgetUsd ?? null },
      },
      payouts: pays, paidUsd: r2(pays.filter((p) => okStatus(p.status)).reduce((s, p) => s + p.usd, 0)),
      rules: c.rules, funding: c.funding, minPayoutUsd: c.min_payout_usd, holderWeight: c.holder_weight,
      payer: { mode, canPay: isMock() || !!acct(), key: isMock() ? null : acct() ? 'set' : 'missing' }, status: last,
    }
  }

  let timers = []
  function start() {
    const t1 = async () => { await poll(); try { await tick() } catch (e) { log.error?.(`prizes: ${e.stack || e.message}`) } }
    t1(); timers.push(setInterval(t1, 15_000))
    const t2 = () => scanLogs().catch(() => {})
    setTimeout(t2, 5_000); timers.push(setInterval(t2, 5 * 60_000))
    for (const t of timers) t.unref?.()
  }
  return { readWallet, poll, scanLogs, lockBudgets, plan, send, sendOne, tick, roundPrize, wonBy, overview, checkNonce, start, stop: () => timers.forEach(clearInterval), status: () => last }
}
