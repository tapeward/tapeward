// Share card PNG 1200×630 (style A, election-night broadcast): /api/card/:round/:addr.png
// SVG rendered with @resvg/resvg-js using the bundled OFL fonts in server/assets/fonts (Archivo ExtraBold + IBM Plex Mono).
// Cards are cached in memory per view model (so a new anchor / settle changes the card) for 10 min.
// Status line follows the pick: "signed · recording on Robinhood Chain…" → "recorded on Robinhood Chain · tx 0x…" → "scored: N pts · settle tx 0x…"
// → "won $X in SYMBOL · tx 0x…" once a prize payout exists for that wallet and round.
import { readdirSync } from 'node:fs'
import { SERVER_DIR } from './config.mjs'

const C = { navy: '#070d20', navy2: '#0b1430', panel: '#121d3f', line: '#24315e', text: '#f4f6fb', dim: '#9aa6c7', red: '#e0323c', blue: '#2f6bff', purple: '#8a5cf6' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = (bp) => `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${(Math.abs(bp) / 100).toFixed(2)} %`
const shortTx = (tx) => (/^0x[0-9a-fA-F]{64}$/.test(String(tx || '')) ? `${tx.slice(0, 6)}…${tx.slice(-4)}` : null)
/** state of the pick shown on the card: signed → recorded on Robinhood Chain (tx) → scored (pure, tested).
 *  Card wording never says merkle / root / anchor / stamp / hash (the mechanism is described on /docs). */
export function proofLine(v) {
  if (v.won) return `won $${Number(v.won.usd).toFixed(2)}${v.won.symbol ? ` in ${v.won.symbol}` : ''}${shortTx(v.won.tx) ? ` · tx ${shortTx(v.won.tx)}` : ''}`
  if (v.score != null) return `scored: ${v.score} pts${v.settleTx && shortTx(v.settleTx) ? ` · settle tx ${shortTx(v.settleTx)}` : ''}`
  if (v.anchor) return `recorded on Robinhood Chain${shortTx(v.anchor.tx) ? ` · tx ${shortTx(v.anchor.tx)}` : ''}`
  return 'signed · recording on Robinhood Chain…'
}
export const callWords = (side, bp) => (bp === 0 ? 'Dead heat: RED and BLUE level' : `${side === 'BLUE' || side === 1 ? 'BLUE beats RED' : 'RED beats BLUE'} by ${(Math.abs(bp) / 100).toFixed(2)} %`)

const frame = (v, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.navy}"/>
  <rect x="0" y="0" width="1200" height="96" fill="${C.navy2}"/>
  <rect x="0" y="92" width="600" height="6" fill="${C.red}"/><rect x="600" y="92" width="600" height="6" fill="${C.blue}"/>
  <text x="60" y="64" font-family="Archivo" font-weight="800" font-size="46" letter-spacing="4" fill="${C.text}">${esc(v.name || 'TAPEWARD')}</text>
  <text x="1140" y="62" text-anchor="end" font-family="IBM Plex Mono" font-size="26" fill="${C.dim}">${esc(v.roundLabel || '')}</text>
  ${body}
  <rect x="0" y="560" width="1200" height="70" fill="${C.panel}"/>
  <text x="60" y="604" font-family="Archivo" font-weight="800" font-size="30" fill="${C.text}">DON'T CALL THE WINNER. CALL THE MARKET.</text>
  <text x="1140" y="604" text-anchor="end" font-family="IBM Plex Mono" font-size="24" fill="${C.dim}">${esc(v.domain || 'tapeward.live')}</text>
</svg>`

/** generic card (no pick for this wallet / unknown round) */
export const genericSvg = (v) => frame(v, `
  <text x="60" y="240" font-family="Archivo" font-weight="800" font-size="64" fill="${C.text}">RED basket vs BLUE basket</text>
  <text x="60" y="320" font-family="Archivo" font-weight="800" font-size="44" fill="${C.dim}">into the US midterms</text>
  <rect x="60" y="400" width="1080" height="2" fill="${C.line}"/>
  <text x="60" y="460" font-family="IBM Plex Mono" font-size="28" fill="${C.text}">Free signed picks · daily rounds + Election Night</text>
  <text x="60" y="505" font-family="IBM Plex Mono" font-size="22" fill="${C.dim}">recorded on Robinhood Chain · prices: Chainlink</text>`)

/** sealed card: who made a call, never the side or spread */
export function sealedSvg(v) {
  const short = `${v.address.slice(0, 6)}…${v.address.slice(-4)}`
  return frame(v, `
  <text x="60" y="170" font-family="IBM Plex Mono" font-size="26" fill="${C.dim}">${esc(v.desk ? `${v.desk} · ${short}` : short)}</text>
  <rect x="60" y="200" width="230" height="70" rx="6" fill="${C.purple}"/>
  <text x="175" y="252" text-anchor="middle" font-family="Archivo" font-weight="800" font-size="50" fill="${C.text}">SEALED</text>
  <text x="60" y="345" font-family="Archivo" font-weight="800" font-size="44" fill="${C.text}">${esc(short)} made a call</text>
  <rect x="60" y="400" width="1080" height="2" fill="${C.line}"/>
  <text x="60" y="460" font-family="IBM Plex Mono" font-size="28" fill="${C.text}">Sealed until ${esc(v.sealedUntil)} · revealed when picks close</text>
  <text x="60" y="505" font-family="IBM Plex Mono" font-size="22" fill="${C.dim}">${esc(v.signedAt)} · ${esc(proofLine(v))}</text>`)
}

/** card SVG from a plain view model (pure, tested) */
export function cardSvg(v) {
  if (v.generic) return genericSvg(v)
  if (v.sealed) return sealedSvg(v)
  const sideCol = v.side === 'BLUE' ? C.blue : C.red
  const short = `${v.address.slice(0, 6)}…${v.address.slice(-4)}`
  const result = v.actual == null ? (v.live == null ? 'Race not scored yet' : `Live, unofficial: RED ${pct(v.live.redBp)} · BLUE ${pct(v.live.blueBp)}`)
    : `Result: RED ${pct(v.actual.redBp)} · BLUE ${pct(v.actual.blueBp)} · spread ${v.actual.spreadBp} bp`
  const score = v.score == null ? '' : `<text x="1140" y="262" text-anchor="end" font-family="Archivo" font-weight="800" font-size="128" fill="${C.text}">${esc(v.score)}</text>
    <text x="1140" y="300" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="${C.dim}">POINTS / 200${v.rank ? ` · RANK ${esc(v.rank)} OF ${esc(v.of)}` : ''}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.navy}"/>
  <rect x="0" y="0" width="1200" height="96" fill="${C.navy2}"/>
  <rect x="0" y="92" width="600" height="6" fill="${C.red}"/><rect x="600" y="92" width="600" height="6" fill="${C.blue}"/>
  <text x="60" y="64" font-family="Archivo" font-weight="800" font-size="46" letter-spacing="4" fill="${C.text}">${esc(v.name || 'TAPEWARD')}</text>
  <text x="1140" y="62" text-anchor="end" font-family="IBM Plex Mono" font-size="26" fill="${C.dim}">${esc(v.roundLabel)}</text>
  <text x="60" y="170" font-family="IBM Plex Mono" font-size="26" fill="${C.dim}">${esc(v.desk ? `${v.desk} · ${short}` : short)} CALLED</text>
  <rect x="60" y="200" width="${v.side === 'BLUE' ? 170 : 150}" height="70" rx="6" fill="${sideCol}"/>
  <text x="${v.side === 'BLUE' ? 145 : 135}" y="252" text-anchor="middle" font-family="Archivo" font-weight="800" font-size="50" fill="${C.text}">${esc(v.side)}</text>
  <text x="60" y="345" font-family="Archivo" font-weight="800" font-size="44" fill="${C.text}">${esc(callWords(v.side, v.spreadBp))}</text>
  ${score}
  <rect x="60" y="400" width="1080" height="2" fill="${C.line}"/>
  <text x="60" y="460" font-family="IBM Plex Mono" font-size="28" fill="${C.text}">${esc(result)}</text>
  <text x="60" y="505" font-family="IBM Plex Mono" font-size="22" fill="${C.dim}">${esc(v.signedAt)} · ${esc(proofLine(v))} · prices: Chainlink</text>
  <rect x="0" y="560" width="1200" height="70" fill="${C.panel}"/>
  <text x="60" y="604" font-family="Archivo" font-weight="800" font-size="30" fill="${C.text}">DON'T CALL THE WINNER. CALL THE MARKET.</text>
  <text x="1140" y="604" text-anchor="end" font-family="IBM Plex Mono" font-size="24" fill="${C.dim}">${esc(v.domain || 'tapeward.live')}</text>
</svg>`
}

let Resvg = null, fontFiles = null
async function renderer() {
  if (Resvg === null) {
    try { ({ Resvg } = await import('@resvg/resvg-js')) } catch { Resvg = false }
    try { fontFiles = readdirSync(SERVER_DIR + 'assets/fonts').filter((f) => /\.(ttf|otf)$/.test(f)).map((f) => SERVER_DIR + 'assets/fonts/' + f) } catch { fontFiles = [] }
  }
  return Resvg
}

const cache = new Map()
/** → { type, body } (PNG, or SVG when resvg is unavailable) */
export async function renderCard(v) {
  const key = JSON.stringify(v)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 600_000) return hit.out
  const svg = cardSvg(v)
  const R = await renderer()
  let out
  if (R) {
    const png = new R(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono' } }).render().asPng()
    out = { type: 'image/png', body: Buffer.from(png) }
  } else out = { type: 'image/svg+xml', body: Buffer.from(svg) }
  cache.set(key, { at: Date.now(), out })
  if (cache.size > 500) cache.delete(cache.keys().next().value)
  return out
}
