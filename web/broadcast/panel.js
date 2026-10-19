// MAKE YOUR CALL: round → side → spread → EIP-712 signature → POST /api/pick → receipt with on-chain status.
import { $, $$, h, clock, fmtUtc, fmtDur, pct, bpTxt, short, txUrl, copyButton, toast, usd } from '/shared/site.js'
import { pickRounds, roundStatus, postPick, getWallet, prizeInfo } from '/shared/api.js'
import { wallet, signPick, isRejection, walletsReady, ask } from '/shared/wallet.js'

const BASKET = { RED: ['TSLA', 'SPCX', 'COIN', 'PLTR', 'USO', 'USAR'], BLUE: ['TSM', 'ASML', 'AAPL', 'AMZN', 'BABA', 'EWY'] }
const MAX = 2000, STEP = 5

export function initPanel({ getState, reduced }) {
  const root = $('#call'), body = $('[data-panel]'), scrim = $('[data-scrim]'), opener = $('#call-open')
  const ui = { roundId: null, side: null, mag: 100, slot: 0, me: null, receipt: null, busy: false, err: null, step: null }
  let lastFocus = null, pollT = null

  // ── open / close ──────────────────────────────────────────────────────────────────────────
  function open() {
    lastFocus = document.activeElement
    root.hidden = false; scrim.hidden = false
    requestAnimationFrame(() => { root.classList.add('open'); scrim.classList.add('open') })
    opener.setAttribute('aria-expanded', 'true')
    document.body.classList.add('panel-open')
    render()
    walletsReady().then(() => wallet.restore()).then(() => { render(); if (wallet.address) loadMe() })
    setTimeout(() => (root.querySelector('[data-close]'))?.focus(), reduced ? 0 : 60)
    clearInterval(pollT); pollT = setInterval(() => { if (wallet.address && ui.receipt && !ui.receipt.anchored) loadMe() }, 30000)
  }
  function close() {
    root.classList.remove('open'); scrim.classList.remove('open')
    opener.setAttribute('aria-expanded', 'false')
    document.body.classList.remove('panel-open')
    const done = () => { root.hidden = true; scrim.hidden = true }
    reduced ? done() : setTimeout(done, 280)
    clearInterval(pollT)
    lastFocus?.focus?.()
  }
  opener.addEventListener('click', open)
  scrim.addEventListener('click', close)
  root.querySelector('[data-close]').addEventListener('click', close)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = $$('button:not([disabled]), a[href], input:not([disabled]), select, [tabindex="0"]', root).filter((x) => x.offsetParent !== null)
      if (!f.length) return
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
    }
  })
  if (location.hash === '#call') setTimeout(open, 400)

  // ── data ──────────────────────────────────────────────────────────────────────────────────
  function rounds() {
    const s = getState(); if (!s) return []
    const { election, daily } = pickRounds(s)
    const now = clock.now()
    const list = []
    if (election && roundStatus(election, now) === 'open') list.push(election)
    daily.filter((r) => roundStatus(r, now) === 'open').sort((a, b) => a.lock - b.lock).forEach((r) => list.push(r))
    return list
  }
  const current = () => { const l = rounds(); return l.find((r) => r.id === ui.roundId) || l[0] || null }
  async function walletNonce() {
    if (!wallet.provider || !wallet.address) return null
    const cid = await ask(wallet.provider, 'eth_chainId', undefined, 8000)
    if (parseInt(cid, 16) !== 4663) return null
    const n = await ask(wallet.provider, 'eth_getTransactionCount', [wallet.address, 'latest'], 8000)
    return parseInt(n, 16)
  }
  // own calls kept in this browser so a sealed round still shows them to their owner
  const LSP = 'tapeward.mypicks'
  function localPick(roundId, slot) {
    try { return JSON.parse(localStorage.getItem(LSP) || '{}')[String(wallet.address).toLowerCase()]?.[roundId]?.[slot] || null } catch { return null }
  }
  function saveLocalPick(roundId, slot, v) {
    try {
      const all = JSON.parse(localStorage.getItem(LSP) || '{}'), a = String(wallet.address).toLowerCase()
      ;((all[a] ||= {})[roundId] ||= {})[slot] = v
      localStorage.setItem(LSP, JSON.stringify(all))
    } catch {}
  }
  function slotsFor(r) {
    const n = Number(ui.me?.slots?.[r?.id] ?? r?.slots?.you ?? r?.slots?.default)
    return n > 0 ? n : 1
  }
  async function loadMe() {
    if (!wallet.address) return
    try {
      const me = await getWallet(wallet.address)
      ui.me = me
      if (ui.receipt) {
        const p = (me?.picks || []).find((x) => x.round === ui.receipt.roundId && Number(x.slot) === Number(ui.receipt.slot))
        if (p?.anchored) ui.receipt.anchored = p.anchored
      }
      render()
    } catch { /* wallet with no picks yet */ }
  }
  wallet.onChange(() => { ui.me = null; if (wallet.address) loadMe(); render() })

  // ── actions ───────────────────────────────────────────────────────────────────────────────
  const spreadBp = () => (ui.side === 'BLUE' ? -1 : 1) * ui.mag
  function sentence() {
    if (!ui.side) return 'Pick RED or BLUE first.'
    const pctTxt = (ui.mag / 100).toFixed(2).replace(/\.?0+$/, '') || '0'
    if (ui.mag === 0) return 'RED and BLUE finish level.'
    const [a, b] = ui.side === 'RED' ? ['RED', 'BLUE'] : ['BLUE', 'RED']
    return `${a} beats ${b} by ${(ui.mag / 100).toFixed(2)} %`
  }
  async function connect(uuid) {
    ui.err = null; ui.step = 'Approve the connection in your wallet…'; render()
    try {
      await walletsReady()
      await wallet.connect(uuid)
      ui.step = null
      await loadMe()
    } catch (e) { ui.step = null; ui.err = isRejection(e) ? 'Connection cancelled in the wallet.' : e.message || 'The wallet did not connect.' }
    render()
  }
  async function sign() {
    if (ui.busy) return
    const r = current()
    ui.err = null
    if (!r) { ui.err = 'No round is open for picks right now.'; render(); return }
    if (!ui.side) { ui.err = 'Pick RED or BLUE first (step 2).'; render(); body.querySelector('.pn-sidebtn')?.focus(); return }
    ui.busy = true; ui.step = 'Opening your wallet…'; render()
    try {
      if (!wallet.provider) {
        const list = await walletsReady()
        if (!list.length) throw Object.assign(new Error('No browser wallet found. Open this page in a wallet browser or install any EIP-1193 wallet, then reload.'), { code: 'no-wallet' })
        ui.step = 'Approve the connection in your wallet…'; render()
        await wallet.connect()
      }
      const sp = spreadBp()
      const { message, signature } = await signPick({ round: r, side: ui.side, spreadBp: sp, slot: ui.slot, onStep: (t) => { ui.step = t; render() } })
      ui.step = 'Sending your signed call…'; render()
      const pick = { round: r.id, side: ui.side, spreadBp: sp, slot: ui.slot, signedAt: message.signedAt }
      let res
      try { res = await postPick({ address: wallet.address, signature, pick }) } catch (e) {
        if (e.body) throw Object.assign(new Error(`The server refused this pick: ${e.body.error || e.body.reason}`), { code: 'server' })
        throw Object.assign(new Error('Could not reach the server. Your signature was not sent; try again in a moment.'), { code: 'network' })
      }
      if (!res || res.ok === false) throw Object.assign(new Error(`The server refused this pick: ${res?.error || res?.reason || 'no answer'}`), { code: 'server' })
      // prizes need ≥ 1 earlier Robinhood Chain tx: ask the wallet (now on 4663) for this address's nonce
      const notEligible = await walletNonce().then((n) => n === 0).catch(() => false)
      ui.receipt = { notEligible, roundId: r.id, side: ui.side, spreadBp: sp, slot: ui.slot, signedAt: message.signedAt, signature, anchored: res?.pick?.anchored || null, nextAnchorAt: res?.nextAnchorAt || null, replaced: !!res?.replaced, fixture: !!res?.fixture, picksClose: r.picksClose }
      saveLocalPick(r.id, ui.slot, { side: ui.side, spreadBp: sp, signedAt: message.signedAt })
      toast('Call signed and received.')
      loadMe()
    } catch (e) {
      ui.err = e?.code === 4001 ? 'Request cancelled in the wallet. Nothing was sent.' : e?.message || 'Something went wrong. Nothing was sent.'
    }
    ui.busy = false; ui.step = null
    render()
    if (ui.err) body.querySelector('.pn-err')?.scrollIntoView({ block: 'nearest' })
  }

  // ── render ────────────────────────────────────────────────────────────────────────────────
  function render() {
    if (root.hidden && !root.classList.contains('open')) return
    const list = rounds(), r = current()
    if (r && ui.roundId !== r.id) { ui.roundId = r.id; ui.slot = 0 }
    body.textContent = ''
    if (!list.length) {
      body.append(h('p', { class: 'pn-empty' }, 'No round is open for picks right now. The next daily round opens when the current one settles; check back after the close.'))
      return
    }
    // 1 · round
    const tabs = h('div', { class: 'pn-tabs', role: 'tablist', 'aria-label': 'Round' }, list.map((x) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(x.id === r.id),
      onclick: () => { ui.roundId = x.id; ui.slot = 0; ui.receipt = null; render() },
    }, x.kind === 'election' ? 'Election Night' : x.label)))
    const times = h('dl', { class: 'pn-times' },
      h('dt', null, 'Picks close'), h('dd', null, fmtUtc(r.picksClose, { date: true }), ' ', h('span', { class: 'pn-cd', 'data-pn-cd': '' }, `in ${fmtDur(r.picksClose - clock.now())}`)),
      h('dt', null, 'Lock'), h('dd', null, fmtUtc(r.lock, { date: true })),
      ...r.scoreTimes.flatMap((t, i) => [h('dt', null, r.scoreLabels[i] ? `Score · ${r.scoreLabels[i]}` : 'Score'), h('dd', null, fmtUtc(t, { date: true }))]))
    const pz = r.prize
    const prizeLine = h('p', { class: 'pn-prize' }, pz && pz.usd != null && !pz.none
      ? ['Prize ', h('b', null, `${pz.estimate ? '≈ ' : ''}${usd(pz.usd)}`), ` for the top ${pz.top}, paid in ${prizeInfo.paidIn || 'stock tokens or ETH'} · free to play`]
      : pz?.none ? 'No prize in this round (the prize wallet is too small for a daily prize) · free to play' : 'Free to play')
    body.append(step('1', 'Round', tabs, times, prizeLine))

    // 2 · side
    const sideBtn = (s) => h('button', {
      type: 'button', class: `pn-sidebtn ${s.toLowerCase()}`, 'aria-pressed': String(ui.side === s),
      onclick: () => { ui.side = s; render(); body.querySelector(`.pn-sidebtn.${s.toLowerCase()}`)?.focus() },
    }, h('b', null, s), h('span', null, s === 'RED' ? 'Onshore' : 'Open trade'), h('small', null, BASKET[s].join(' · ')))
    body.append(step('2', 'Which basket beats the other?', h('div', { class: 'pn-sides' }, sideBtn('RED'), sideBtn('BLUE'))))

    // 3 · spread
    const range = h('input', { type: 'range', min: 0, max: MAX, step: STEP, value: ui.mag, 'aria-label': 'Spread in basis points', disabled: !ui.side })
    const numIn = h('input', { type: 'number', min: 0, max: MAX, step: STEP, value: ui.mag, inputmode: 'numeric', 'aria-label': 'Spread in basis points (number)', disabled: !ui.side })
    const say = h('p', { class: `pn-say ${ui.side ? ui.side.toLowerCase() : ''}`, 'aria-live': 'polite' }, sentence())
    const bpLine = h('span', { class: 'pn-bp' }, ui.side ? `spreadBp ${spreadBp() > 0 ? '+' : ''}${spreadBp()}` : '')
    const sync = (v) => {
      ui.mag = Math.max(0, Math.min(MAX, Math.round((Number(v) || 0) / STEP) * STEP))
      range.value = ui.mag; numIn.value = ui.mag; say.textContent = sentence()
      bpLine.textContent = ui.side ? `spreadBp ${spreadBp() > 0 ? '+' : ''}${spreadBp()}` : ''
      range.style.setProperty('--p', `${(ui.mag / MAX) * 100}%`)
    }
    range.addEventListener('input', () => sync(range.value))
    numIn.addEventListener('change', () => sync(numIn.value))
    range.style.setProperty('--p', `${(ui.mag / MAX) * 100}%`)
    body.append(step('3', 'By how much?', say, h('div', { class: `pn-range ${ui.side ? ui.side.toLowerCase() : ''}` }, range), h('div', { class: 'pn-num' }, numIn, h('span', null, 'bp'), bpLine),
      h('p', { class: 'pn-help' }, '100 bp = 1 %. Score = 100 if your side is right + up to 100 for how close your spread lands (1 point off per 5 bp). Max 200.')))

    // 4 · sign
    const s4 = []
    if (!wallet.address || !wallet.provider) {
      const ps = wallet.providers
      if (ps.length > 1) {
        s4.push(h('p', { class: 'pn-help' }, 'Choose a wallet:'))
        s4.push(h('div', { class: 'pn-wallets' }, ps.map((p) => h('button', { type: 'button', class: 'btn ghost', disabled: ui.busy, onclick: () => connect(p.info.uuid) },
          p.info.icon ? h('img', { src: p.info.icon, alt: '', width: 18, height: 18 }) : null, `Connect ${p.info.name}`))))
      } else {
        // one injected wallet (or none yet): a single button that connects, then signs
        s4.push(h('button', { type: 'button', class: 'btn pn-sign', disabled: ui.busy, 'aria-busy': String(ui.busy), onclick: sign }, ui.busy ? 'Waiting for your wallet…' : ps.length ? 'Connect wallet & sign' : 'Sign my call'))
        if (!ps.length) s4.push(h('p', { class: 'pn-help' }, 'No browser wallet detected yet. Open this page in a wallet browser or install any EIP-1193 wallet.'))
      }
    } else {
      const n = slotsFor(r)
      const slotSel = n > 1 ? h('label', { class: 'pn-slot' }, 'Slot ', h('select', { onchange: (e) => { ui.slot = Number(e.target.value); render() } },
        Array.from({ length: n }, (_, i) => h('option', { value: i, selected: i === ui.slot }, `${i + 1} of ${n}`)))) : h('span', { class: 'pn-slot' }, `1 slot${r.kind === 'election' ? ' (holders get 3 after launch)' : ''}`)
      s4.push(h('div', { class: 'pn-who' }, h('span', { class: 'chip' }, h('span', { class: 'k' }, 'Wallet'), short(wallet.address, 4)), slotSel,
        h('button', { type: 'button', class: 'pn-link', onclick: () => { wallet.forget(); ui.receipt = null; render() } }, 'Disconnect')))
      s4.push(h('button', { type: 'button', class: 'btn pn-sign', disabled: ui.busy, 'aria-busy': String(ui.busy), onclick: sign }, ui.busy ? 'Waiting for your wallet…' : 'Sign my call'))
    }
    s4.push(h('p', { class: 'pn-help' }, 'Free to play: an EIP-712 signature, no gas, no transaction, no purchase. Your wallet first switches to Robinhood Chain (4663), adding it if needed; that is not a transaction either. Signing again replaces the pick in that slot until picks close.'))
    if (ui.step) s4.push(h('p', { class: 'pn-stepmsg', role: 'status' }, ui.step))
    if (ui.err) s4.push(h('p', { class: 'pn-err', role: 'alert' }, ui.err))
    body.append(step('4', 'Sign it', ...s4))

    // receipt
    if (ui.receipt && ui.receipt.roundId === r.id) body.append(receipt(ui.receipt))
    // my picks in this round
    // the server seals side/spread until picks close; this browser remembers the user's own calls (local only)
    const mine = (ui.me?.picks || []).filter((p) => p.round === r.id).map((p) => (p.side != null && !p.sealed ? p : { ...p, ...(localPick(r.id, p.slot) || {}), sealed: true }))
    if (mine.length) body.append(h('div', { class: 'pn-mine' }, h('h3', null, 'Your picks in this round'), mine.map((p) => h('div', { class: 'pn-pick' },
      p.side ? h('span', { class: `side ${String(p.side).toLowerCase()}` }, p.side) : h('span', { class: 'note' }, 'your call'), p.spreadBp != null ? h('span', { class: 'mono' }, bpTxt(p.spreadBp)) : null,
      h('span', { class: 'note' }, `slot ${Number(p.slot) + 1}${p.sealed ? ' · sealed for others until picks close' : ''}`),
      p.anchored?.tx ? h('a', { href: txUrl(p.anchored.tx), target: '_blank', rel: 'noopener' }, `on chain · tx ${short(p.anchored.tx)}`) : h('span', { class: 'note' }, 'recording…')))))
  }
  function step(n, title, ...kids) {
    return h('section', { class: 'pn-step' }, h('h3', null, h('span', { class: 'n' }, n), title), ...kids)
  }
  function receipt(rc) {
    const share = `/r/${encodeURIComponent(rc.roundId)}/${wallet.address}`
    const status = rc.anchored?.tx
      ? h('p', { class: 'rc-ok' }, 'Recorded on Robinhood Chain · ', h('a', { href: txUrl(rc.anchored.tx), target: '_blank', rel: 'noopener' }, `tx ${short(rc.anchored.tx)}`))
      : h('p', { class: 'rc-wait' }, 'Signed · recording on Robinhood Chain…')
    return h('section', { class: 'pn-receipt', 'aria-live': 'polite' },
      h('h3', null, rc.fixture ? 'Receipt (fixture: not sent)' : rc.replaced ? 'Receipt · replaced your earlier pick' : 'Receipt'),
      h('dl', null,
        h('dt', null, 'Round'), h('dd', null, rc.roundId),
        h('dt', null, 'Call'), h('dd', null, h('span', { class: `side ${rc.side.toLowerCase()}` }, rc.side), ` ${bpTxt(rc.spreadBp)}`),
        h('dt', null, 'Slot'), h('dd', null, String(rc.slot + 1)),
        h('dt', null, 'Signed'), h('dd', null, fmtUtc(rc.signedAt, { date: true })),
        h('dt', null, 'Signature'), h('dd', { class: 'mono' }, short(rc.signature, 6), copyButton(() => rc.signature, 'Copy signature'))),
      status,
      rc.notEligible ? h('p', { class: 'rc-note' }, 'Your call counts on the board; prizes need a wallet with at least one Robinhood Chain transaction.') : null,
      h('a', { class: 'pn-link', href: share }, 'Your share page →'))
  }

  return {
    update() { if (!root.hidden) render() },
    tick() {
      const r = current(); const el = root.hidden ? null : root.querySelector('[data-pn-cd]')
      if (el && r) { const ms = r.picksClose - clock.now(); el.textContent = ms > 0 ? `in ${fmtDur(ms)}` : 'closed'; if (ms <= 0) render() }
    },
  }
}
