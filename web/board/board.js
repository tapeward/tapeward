// /board: round tabs, ranks, desks, the house desk record. Reads /api/state (rounds, desk) + /api/board?round=.
import { $, h, fmtUtc, pct, bpTxt, short, txUrl, addrUrl, toDate, nf, usd, amt } from '/shared/site.js'
import { getState, getBoard, getProof, roundStatus, FIXTURE } from '/shared/api.js'

const q = new URLSearchParams(location.search)
let me = null
try { me = (localStorage.getItem('tapeward.addr') || '').toLowerCase() } catch {}
let state = null, roundId = q.get('round')

const sideOf = (s) => (s === 1 || s === '1' || String(s).toUpperCase() === 'BLUE' ? 'BLUE' : 'RED')
const rowsOf = (b) => b?.rows || b?.board || b?.entries || b?.ranks || []

// prize on a board row, SERVER shape {place, usd, symbol, amount, status, tx, link}
const PAID = new Set(['confirmed', 'mock'])
function prizeCell(r) {
  const p = r.prize
  if (!p) return h('span', { class: 'note' }, '—')
  const v = `${usd(p.usd)}${p.amount != null && p.symbol ? ` · ${amt(p.amount)} ${p.symbol}` : ''}`
  if (p.status === 'rolled_over') return h('span', { class: 'note', title: 'Under $0.10: stays in the prize wallet for the next round' }, `${usd(p.usd)} · rolls over`)
  if (p.status === 'skipped') return h('span', { class: 'note', title: 'The prize wallet could not cover it: stays for the next round' }, `${usd(p.usd)} · carried over`)
  if (PAID.has(p.status) && p.tx) return h('span', { class: 'mono' }, v, ' · ', p.link ? h('a', { href: p.link, target: '_blank', rel: 'noopener' }, `tx ${short(p.tx, 3)}`) : `tx ${short(p.tx, 3)}`)
  return h('span', { class: 'mono' }, v, h('span', { class: 'note' }, ' · paying'))
}

function tabs(list) {
  const el = $('[data-tabs]'); el.textContent = ''
  for (const r of list) {
    el.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(r.id === roundId), onclick: () => { roundId = r.id; history.replaceState(null, '', `?round=${encodeURIComponent(r.id)}${q.get('fixture') ? `&fixture=${q.get('fixture')}` : ''}`); tabs(list); load() } },
      r.kind === 'election' ? 'Election Night' : r.id.replace(/^D-/, 'Daily '), h('span', { class: 'sr' }, ` (${r.status})`)))
  }
}

async function load() {
  const tb = $('[data-table] tbody')
  tb.innerHTML = '<tr><td colspan="8" class="empty">Loading the board…</td></tr>'
  let b = null
  try { b = await getBoard(roundId) } catch (e) { tb.innerHTML = ''; tb.append(h('tr', null, h('td', { colspan: 8, class: 'empty' }, `The board for ${roundId} is not available yet (${e.status || e.message}).`))); return }
  const round = state?.rounds.find((r) => r.id === roundId)
  const actual = (b?.result?.spreadBp != null ? b.result : null) || b?.actual || (round?.results?.[0] ? round.results[0] : null)
  const rows = rowsOf(b)
  // summary
  const sum = $('[data-summary]'); sum.textContent = ''
  const stat = (k, v, link) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, link ? h('a', { href: link, target: '_blank', rel: 'noopener' }, v) : v))
  sum.append(stat('Status', (b?.status || round?.status || '—').toUpperCase()))
  if (b?.scoreLabel && b.scoreLabel !== 'Close') sum.append(stat('Score', b.scoreLabel))
  sum.append(stat('Picks', nf(b?.count ?? rows.length)))
  if (actual?.spreadBp != null) {
    sum.append(stat('RED', pct(actual.redBp)), stat('BLUE', pct(actual.blueBp)), stat('Actual spread', bpTxt(actual.spreadBp), actual.tx ? txUrl(actual.tx) : null))
  } else if (round) sum.append(stat('Lock', fmtUtc(round.lock, { date: true })), stat(round.kind === 'election' ? 'Day one score' : 'Score', fmtUtc(round.scoreTimes[0], { date: true })))
  const pz = round?.prize
  const paid = rows.reduce((t, r) => t + (r.prize && PAID.has(r.prize.status) ? Number(r.prize.usd) || 0 : 0), 0)
  if (paid > 0) sum.append(stat('Prizes paid', usd(paid)))
  else if (pz && (pz.usd != null || pz.none)) sum.append(stat(pz.none ? 'Prize' : `Prize · top ${pz.top}`, pz.none ? 'None today' : `${pz.estimate ? '≈ ' : ''}${usd(pz.usd)}`))
  if (b?.aftershock?.spreadBp != null) sum.append(stat('Aftershock spread', bpTxt(b.aftershock.spreadBp), b.aftershock.tx ? txUrl(b.aftershock.tx) : null))
  $('[data-board-note]').textContent = actual?.spreadBp != null
    ? `Scored from Chainlink prices on Robinhood Chain${actual.tx ? ` · settle tx ${short(actual.tx)}` : ''}.`
    : 'No result yet: the ranking appears once the round is settled on Robinhood Chain. Until then the table lists the recorded picks in signing order.'
  // table
  tb.textContent = ''
  if (!rows.length) { tb.append(h('tr', null, h('td', { colspan: 8, class: 'empty' }, 'No picks in this round yet. Be the first: make your call on the live page.'))); return }
  for (const [i, r] of rows.entries()) {
    const addr = r.address || r.addr || r.picker || ''
    const side = sideOf(r.side)
    const mine = me && addr.toLowerCase() === me
    tb.append(h('tr', { class: mine ? 'me' : null },
      h('td', { class: 'num' }, String(r.rank ?? i + 1)),
      h('td', null, r.desk ? h('span', null, h('b', null, r.desk), ' ') : null, h('a', { class: 'mono', href: `/r/${encodeURIComponent(roundId)}/${addr}` }, short(addr, 4)), mine ? h('span', { class: 'tag ok', style: 'margin-left:8px' }, 'You') : null, r.house ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'House') : null),
      h('td', null, h('span', { class: `side ${side.toLowerCase()}` }, side)),
      h('td', { class: 'num' }, bpTxt(r.spreadBp)),
      h('td', { class: 'num' }, String(Number(r.slot ?? 0) + 1)),
      h('td', { class: 'mono' }, fmtUtc(toDate(r.signedAt), { date: true })),
      h('td', { class: 'num' }, r.score == null ? '—' : Number(r.score).toFixed(2)),
      h('td', null, prizeCell(r))))
  }
  if (b?.house && !rows.some((r) => r.house)) $('[data-board-note]').append(` The house desk called ${sideOf(b.house.side)} ${bpTxt(b.house.spreadBp)}${b.house.score != null ? ` and scored ${Number(b.house.score).toFixed(2)}` : ''}${b.house.rank ? ` (rank ${b.house.rank})` : ''}.`)
}

function desk() {
  const d = state?.desk
  const rec = d?.record || {}
  const st = $('[data-desk-stats]'); st.textContent = ''
  const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))
  st.append(stat('Desk', d?.name || 'TAPEWARD desk'), stat('Calls', nf(rec.calls ?? 0)), stat('Right side', nf(rec.right ?? 0)), stat('Missed', nf(rec.missed ?? 0)))
  if (rec.avg != null) st.append(stat('Avg score', Number(rec.avg).toFixed(1)))
  if (d?.address) st.append(h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Signs as'), h('div', { class: 'v' }, h('a', { href: addrUrl(d.address), target: '_blank', rel: 'noopener', class: 'mono', style: 'font-size:15px' }, short(d.address, 4)))))
  const tb = $('[data-desk] tbody'); tb.textContent = ''
  const rows = (rec.rows || []).filter((r) => r.score != null || r.actual != null)
  // current open calls from the rounds, then the record
  const open = (state?.rounds || []).filter((r) => r.house && !['scored'].includes(roundStatus(r)))
  for (const r of open) tb.append(h('tr', null, h('td', { class: 'mono' }, r.id), h('td', null, h('span', { class: `side ${sideOf(r.house.side).toLowerCase()}` }, sideOf(r.house.side))), h('td', { class: 'num' }, bpTxt(r.house.spreadBp)), h('td', { class: 'num' }, '—'), h('td', null, h('span', { class: 'tag' }, roundStatus(r) === 'open' ? 'Picks open' : 'Waiting for score')), h('td', { class: 'num' }, '—')))
  for (const r of rows) {
    const side = sideOf(r.side), ok = r.right ?? (r.actual != null ? Math.sign(r.actual) === (side === 'RED' ? 1 : -1) : null)
    tb.append(h('tr', null, h('td', { class: 'mono' }, r.round), h('td', null, h('span', { class: `side ${side.toLowerCase()}` }, side)), h('td', { class: 'num' }, bpTxt(r.spreadBp)), h('td', { class: 'num' }, bpTxt(r.actual)),
      h('td', null, ok == null ? '—' : h('span', { class: `tag ${ok ? 'ok' : ''}` }, ok ? 'Right side' : 'Missed')), h('td', { class: 'num' }, r.score == null ? '—' : Number(r.score).toFixed(2))))
  }
  if (!open.length && !rows.length) tb.append(h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'The desk has no scored calls yet.')))
}

// every round with its settle tx (from /api/proof events + the rounds in state)
async function roundsTable(list) {
  const tb = $('[data-rounds] tbody')
  let p = null
  try { p = await getProof() } catch {}
  const settles = (p?.events || []).filter((e) => e.type === 'settle')
  const ids = [...new Set([...list.map((r) => r.id), ...settles.map((e) => e.round), ...(p?.events || []).filter((e) => e.type === 'openRound').map((e) => e.round)])].filter(Boolean)
  ids.sort((a, b) => (/^ELECTION/.test(a) - /^ELECTION/.test(b)) || b.localeCompare(a))
  tb.textContent = ''
  for (const id of ids) {
    const ss = settles.filter((e) => e.round === id).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const r0 = ss[0] || state?.rounds.find((r) => r.id === id)?.results?.[0]
    tb.append(h('tr', null,
      h('td', null, h('a', { class: 'mono', href: `?round=${encodeURIComponent(id)}`, onclick: (e) => { e.preventDefault(); roundId = id; tabs(list); load(); scrollTo({ top: 0, behavior: 'smooth' }) } }, id)),
      h('td', { class: 'num' }, r0?.redBp != null ? pct(r0.redBp) : '—'), h('td', { class: 'num' }, r0?.blueBp != null ? pct(r0.blueBp) : '—'), h('td', { class: 'num' }, r0?.spreadBp != null ? bpTxt(r0.spreadBp) : '—'),
      h('td', null, ss.length ? ss.flatMap((e, i) => [i ? ' · ' : '', e.label && e.label !== 'Close' ? `${e.label} ` : '', h('a', { class: 'mono', href: txUrl(e.tx), target: '_blank', rel: 'noopener' }, short(e.tx, 4))]) : r0?.tx ? h('a', { class: 'mono', href: txUrl(r0.tx), target: '_blank', rel: 'noopener' }, short(r0.tx, 4)) : h('span', { class: 'note' }, 'after the score time'))))
  }
  if (!ids.length) tb.append(h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'No rounds yet.')))
}

;(async () => {
  try { state = await getState() } catch {}
  let list = (state?.rounds || []).filter((r) => r.raw?.status !== 'scheduled')
  const b0 = roundId || !FIXTURE ? null : await getBoard(null).catch(() => null)
  // the board endpoint may list older rounds too
  for (const id of b0?.rounds || []) if (!list.some((r) => r.id === id)) list = [...list, { id, kind: /^ELECTION/.test(id) ? 'election' : 'daily', status: 'scored' }]
  list = [...list].sort((a, b) => (a.kind === 'election') - (b.kind === 'election') || String(b.id).localeCompare(String(a.id)))
  const rank = (r) => (['settled', 'scored'].includes(r.status) ? 0 : ['live', 'locked', 'settling'].includes(r.status) ? 1 : 2)
  if (!roundId) roundId = b0?.round || [...list].sort((a, b) => rank(a) - rank(b))[0]?.id
  if (!list.some((r) => r.id === roundId) && roundId) list.unshift({ id: roundId, kind: /^ELECTION/.test(roundId) ? 'election' : 'daily', status: '' })
  tabs(list)
  desk()
  roundsTable(list)
  if (roundId) load()
  else $('[data-table] tbody').innerHTML = '<tr><td colspan="8" class="empty">No rounds yet.</td></tr>'
})()
