// /docs: token-dependent lines, the disclaimer, and the "On chain" section (contract, poster, per-round table) from /api/proof.
import { $, h, onConfig, token, isLive, isAddr, addrUrl, txUrl, short, fmtUtc, toDate, copyButton, usd, amt, DISCLAIMER, PRIZE_WALLET } from '/shared/site.js'
import { getProof, getPrizes } from '/shared/api.js'

// deployed RaceBook (the API's value wins when it sends one)
const RACEBOOK = '0x098cB14018B986bC61C4Ac629088829944E6d924'
$('[data-disclaimer]').textContent = DISCLAIMER
const arr = (v) => (Array.isArray(v) ? v : [])
const tx = (t) => (t ? h('a', { class: 'mono', href: txUrl(t), target: '_blank', rel: 'noopener' }, short(t, 4)) : h('span', { class: 'note' }, '—'))

function addrCard(title, a, note, extra) {
  return h('div', { class: 'card' }, h('div', { class: 'kicker', style: 'margin-bottom:8px' }, title),
    h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' }, h('a', { class: 'mono', href: addrUrl(a), target: '_blank', rel: 'noopener', style: 'word-break:break-all' }, a), copyButton(() => a, `Copy ${title}`)),
    h('p', { class: 'note', style: 'margin:8px 0 0' }, note), extra || null)
}

async function onchain() {
  let p = null
  try { p = await getProof() } catch {}
  const contract = [p?.contract, token.racebook, RACEBOOK].find(isAddr)
  const poster = isAddr(p?.poster) ? p.poster : '0x9ed6dB374aEE462fA60432254bace118a90Fe1C9'
  const box = $('[data-addrs]'); box.textContent = ''
  box.append(
    addrCard('RaceBook contract', contract, 'Holds every round, the recorded picks and each settle result.',
      h('p', { class: 'note', style: 'margin:6px 0 0' }, h('a', { href: addrUrl(contract), target: '_blank', rel: 'noopener' }, 'Blockscout'), ' · ', h('a', { href: `https://repo.sourcify.dev/4663/${contract}`, target: '_blank', rel: 'noopener' }, 'source verified on Sourcify'))),
    addrCard('Poster wallet', poster, 'Opens rounds, records picks and settles. Anyone else can call settle too.'))

  // per round: opened tx · picks recorded · latest record · settle tx(s)
  const ev = arr(p?.events)
  const rounds = new Map()
  const row = (id) => { if (!rounds.has(id)) rounds.set(id, { id, open: null, count: null, last: null, settles: [] }); return rounds.get(id) }
  for (const e of ev) {
    if (!e.round) continue
    const r = row(e.round)
    if (e.type === 'openRound') r.open = e
    if (e.type === 'anchor') { if (!r.last || toDate(e.at) > toDate(r.last.at)) r.last = e; r.count = Math.max(r.count ?? 0, Number(e.count) || 0) }
    if (e.type === 'settle') r.settles.push(e)
  }
  const tb = $('[data-onchain] tbody'); tb.textContent = ''
  const list = [...rounds.values()].sort((a, b) => (toDate(b.open?.at) || 0) - (toDate(a.open?.at) || 0))
  for (const r of list) {
    tb.append(h('tr', null,
      h('td', { class: 'mono' }, r.id),
      h('td', null, r.open?.tx ? tx(r.open.tx) : '—', r.open?.at ? h('span', { class: 'note' }, ` ${fmtUtc(r.open.at, { date: true })}`) : null),
      h('td', { class: 'num' }, r.count == null ? '0' : String(r.count)),
      h('td', null, r.last?.tx ? tx(r.last.tx) : h('span', { class: 'note' }, '—')),
      h('td', null, r.settles.length ? r.settles.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).flatMap((s, i) => [i ? ' · ' : '', s.label && s.label !== 'Close' ? `${s.label} ` : '', tx(s.tx)]) : h('span', { class: 'note' }, 'after the score time'))))
  }
  if (!list.length) tb.append(h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'No round on chain yet.')))

  const ft = $('[data-feeds] tbody'); ft.textContent = ''
  for (const f of arr(p?.feeds)) ft.append(h('tr', null, h('td', null, h('span', { class: `side ${String(f.basket).toLowerCase()}` }, f.basket === 'REF' ? 'Ref' : f.basket)), h('td', null, h('b', null, f.symbol)), h('td', null, f.name || f.description || ''), h('td', { class: 'mono' }, h('a', { href: addrUrl(f.proxy), target: '_blank', rel: 'noopener' }, f.proxy))))
  if (!ft.children.length) ft.append(h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'Feed list unavailable.')))
}

// SERVER /api/prizes: {wallet, link, valueUsd, eth:{amount, usd}, holdings:[{symbol, amount, usd}], topups:[{kind, symbol, amount, usd,
// from, tx, link, at}], budgets, payouts:[{round, rank, address, usd, symbol, amount, status, tx, link}], paidUsd, funding}
async function prizes() {
  let p = null
  try { p = await getPrizes() } catch {}
  const w = isAddr(p?.wallet) ? p.wallet : PRIZE_WALLET
  const box = $('[data-prize-wallet]'); box.textContent = ''
  box.append(addrCard('Prize wallet', w, 'Pays the prizes. Every top-up in and every prize out is a public transfer on Robinhood Chain.'))
  const hold = arr(p?.holdings).filter((x) => Number(x.amount) > 0)
  if (p) $('[data-paid-in-now]').textContent = hold.length ? `Right now it holds ${hold.map((x) => x.symbol).join(', ')}, so prizes are paid in those stock tokens (or ETH).` : 'Right now the prize wallet holds only ETH, so prizes are paid in ETH.'
  const parts = [p?.eth?.amount ? `${amt(p.eth.amount)} ETH (${usd(p.eth.usd)})` : null, ...arr(p?.holdings).map((x) => `${amt(x.amount)} ${x.symbol} (${usd(x.usd)})`)].filter(Boolean)
  box.append(h('div', { class: 'card' }, h('div', { class: 'kicker', style: 'margin-bottom:8px' }, 'Value now'),
    h('div', { class: 'mono', style: 'font-size:26px' }, p?.valueUsd != null ? usd(p.valueUsd) : '—'),
    parts.length ? h('p', { class: 'note', style: 'margin:6px 0 0' }, parts.join(' · ')) : null,
    p?.paidUsd ? h('p', { class: 'note', style: 'margin:6px 0 0' }, `Paid out in prizes so far: ${usd(p.paidUsd)}`) : null,
    h('p', { class: 'note', style: 'margin:6px 0 0' }, 'Valued with Chainlink prices on Robinhood Chain.')))
  const link = (x) => (x.link ? h('a', { class: 'mono', href: x.link, target: '_blank', rel: 'noopener' }, short(x.tx, 4)) : x.tx ? h('span', { class: 'mono' }, short(x.tx, 4)) : h('span', { class: 'note' }, x.kind === 'native' ? 'native transfer' : '—'))
  const tt = $('[data-topups] tbody'); tt.textContent = ''
  for (const t of arr(p?.topups)) tt.append(h('tr', null, h('td', { class: 'mono' }, fmtUtc(toDate(t.at), { date: true })), h('td', { class: 'mono' }, t.from ? h('a', { href: addrUrl(t.from), target: '_blank', rel: 'noopener' }, short(t.from, 4)) : '—'),
    h('td', { class: 'num' }, `${amt(t.amount)} ${t.symbol || 'ETH'}${t.usd != null ? ` (${usd(t.usd)})` : ''}`), h('td', null, link(t))))
  if (!tt.children.length) tt.append(h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No top-up yet.')))
  const ST = { confirmed: '', mock: '', sent: ' · sending', signed: ' · sending', planned: ' · queued', rolled_over: ' · rolled over', skipped: ' · carried over' }
  const pt = $('[data-payouts] tbody'); pt.textContent = ''
  for (const x of arr(p?.payouts).slice(0, 30)) pt.append(h('tr', null, h('td', { class: 'mono' }, x.round), h('td', { class: 'num' }, String(x.rank ?? '')), h('td', { class: 'mono' }, x.address ? h('a', { href: `/r/${encodeURIComponent(x.round)}/${x.address}` }, short(x.address, 4)) : '—'),
    h('td', { class: 'num' }, `${usd(x.usd)}${x.amount != null && x.symbol ? ` · ${amt(x.amount)} ${x.symbol}` : ''}${ST[x.status] ?? ''}`), h('td', null, link(x))))
  if (!pt.children.length) pt.append(h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'No prize paid yet.')))
}
prizes()

onConfig(() => {
  const min = Number(token.holder_min) || 0
  const line = $('[data-holder-line]')
  if (isLive() && min > 0) { $('[data-holder-min]').textContent = min.toLocaleString('en-US'); line.hidden = false } else line.hidden = true
  const repo = $('[data-repo-line]'); if (repo) repo.hidden = !token.github
  onchain()
})
