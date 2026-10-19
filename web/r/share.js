// /r/<round>/<address> (or ?round=&addr=): one wallet's call in one round, its on-chain status and score, plus the share card.
import { $, h, fmtUtc, pct, bpTxt, short, txUrl, addrUrl, toDate, usd, amt } from '/shared/site.js'
import { getWallet, getRound, normRound, FIXTURE } from '/shared/api.js'

const q = new URLSearchParams(location.search)
const parts = location.pathname.split('/').filter(Boolean) // ['r', round, addr]
const round = decodeURIComponent(parts[1] || q.get('round') || '')
const addr = (parts[2] || q.get('addr') || '').trim()
const okAddr = /^0x[0-9a-fA-F]{40}$/.test(addr)
const sideOf = (s) => (s === 1 || s === '1' || String(s).toUpperCase() === 'BLUE' ? 'BLUE' : 'RED')

async function main() {
  if (!round || !okAddr) {
    $('[data-h]').textContent = 'No call here'
    $('[data-lede]').textContent = 'This link needs a round and a wallet address, like /r/ELECTION-2026/0x… .'
    $('[data-picks]').textContent = ''
    return
  }
  const label = /^ELECTION/.test(round) ? 'Election Night' : `Daily round · ${round.replace(/^D-/, '')}`
  $('[data-round-k]').textContent = label
  const hd = $('[data-h]'); hd.textContent = 'Call by '; hd.append(h('span', { class: 'mono', style: 'text-transform:none;font-size:.62em;letter-spacing:0' }, short(addr, 4)))
  $('[data-board-link]').href = `/board/?round=${encodeURIComponent(round)}`
  document.title = `${short(addr, 4)} · ${label} · TAPEWARD`
  const card = $('[data-card]')
  const cardUrl = `/api/card/${encodeURIComponent(round)}/${addr}.png`
  if (!FIXTURE) { card.onload = () => (card.hidden = false); card.onerror = () => (card.hidden = true); card.src = cardUrl }
  for (const id of ['og-image', 'tw-image']) document.getElementById(id)?.setAttribute('content', `https://tapeward.live${cardUrl}`)

  const [w, r] = await Promise.all([getWallet(addr).catch(() => null), getRound(round).catch(() => null)])
  const picks = (w?.picks || []).filter((p) => p.round === round)
  const res = r ? normRound(r).results[0] : null // settled results only
  const box = $('[data-picks]'); box.textContent = ''
  $('[data-lede]').textContent = res
    ? `Scored from Chainlink prices on Robinhood Chain: RED ${pct(res.redBp)}, BLUE ${pct(res.blueBp)}, spread ${bpTxt(res.spreadBp)}.`
    : 'Signed for free, recorded on Robinhood Chain before the lock, scored from Chainlink prices on Robinhood Chain.'
  if (res?.tx) $('[data-lede]').append(' Settle tx ', h('a', { href: txUrl(res.tx), target: '_blank', rel: 'noopener' }, short(res.tx)), '.')
  if (!picks.length) { box.append(h('p', { class: 'note' }, 'No pick from this wallet in this round.')); return }
  // SERVER wallet.won: [{round, rank, usd, symbol, amount, status, tx, link}]; only paid ones read "won"
  const won = (w?.won || []).find((x) => x.round === round && ['confirmed', 'mock', 'sent', 'signed'].includes(x.status))
  if (won) box.append(h('p', { class: 'won' }, `Won ${usd(won.usd)}`, won.amount != null && won.symbol ? ` in ${won.symbol} (${amt(won.amount)})` : '', won.rank ? ` · rank ${won.rank}` : '',
    won.tx && ['confirmed', 'mock'].includes(won.status) ? [' · ', h('a', { href: won.link || txUrl(won.tx), target: '_blank', rel: 'noopener' }, `tx ${short(won.tx)}`)] : ' · sending'))
  for (const p of picks) {
    const side = sideOf(p.side)
    box.append(h('div', { class: 'pk' },
      h('div', { class: 'big' }, h('span', { class: `side ${side.toLowerCase()}` }, side), ' ', bpTxt(p.spreadBp)),
      h('dl', null,
        h('dt', null, 'Wallet'), h('dd', null, h('a', { class: 'mono', href: addrUrl(addr), target: '_blank', rel: 'noopener' }, short(addr, 6))),
        h('dt', null, 'Slot'), h('dd', { class: 'mono' }, String(Number(p.slot ?? 0) + 1)),
        h('dt', null, 'Signed'), h('dd', { class: 'mono' }, fmtUtc(toDate(p.signedAt), { date: true })),
        h('dt', null, 'On chain'), h('dd', null, p.anchored?.tx ? h('a', { href: txUrl(p.anchored.tx), target: '_blank', rel: 'noopener' }, `recorded · tx ${short(p.anchored.tx)}`) : 'signed · recording on Robinhood Chain…'),
        h('dt', null, 'Score'), h('dd', { class: 'mono' }, p.score == null ? 'after settle' : `${Number(p.score).toFixed(2)} / 200${p.rank ? ` · rank ${p.rank}` : ''}`))))
  }
}
main()
