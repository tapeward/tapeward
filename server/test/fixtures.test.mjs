// The fixtures WEB builds against (server/fixtures/*.json) must have the same shape as the live API answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeApp, signPick, acct, nowS } from './helpers.mjs'

const fx = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}.json`, import.meta.url)), 'utf8'))
/** paths present in a but not in b (objects: keys; arrays: first element; null on either side matches anything) */
function missing(a, b, path = '$', out = []) {
  if (a === null || b === null || a === undefined || b === undefined) return out
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) { out.push(path + ' (array vs ' + typeof b + ')'); return out }
    if (a.length && b.length && a[0]?.type) {   // event lists: compare entries of the same type
      for (const x of a) { const y = b.find((z) => z?.type === x.type); if (y) missing(x, y, `${path}[type=${x.type}]`, out) }
    } else if (a.length && b.length) missing(a[0], b[0], path + '[0]', out)
    return out
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) { out.push(path + ' (object vs ' + typeof b + ')'); return out }
    if (/\.slots$/.test(path) && !Array.isArray(a)) return out   // map keyed by round id (dynamic)
    for (const k of Object.keys(a)) { if (!(k in b)) out.push(`${path}.${k}`); else missing(a[k], b[k], `${path}.${k}`, out) }
  }
  return out
}

test('fixtures match the live API shapes (both directions)', async () => {
  const app = makeApp({ now: '2026-10-19T08:00:00Z' })
  await app.kalshi.poll()
  await app.rounds.tick()
  const u = acct(3)
  app.clock.set('2026-10-19T08:10:00Z')
  const pk = await app.picks.submit(await signPick(u, { round: 'D-2026-10-19', side: 0, spreadBp: 20, slot: 0, signedAt: nowS(app) }), { ip: 'f' })
  assert.ok(pk.ok)
  for (const t of ['2026-10-19T09:00:02Z', '2026-10-19T13:28:30Z', '2026-10-19T13:30:00Z']) { app.clock.set(t); await app.rounds.tick() }
  app.clock.set('2026-10-19T15:02:10Z')
  await app.rounds.tick()
  const live = {
    state: await app.views.state(),
    round: await app.views.round('D-2026-10-19'),
    picks: app.views.picksDoc('D-2026-10-19'),
    'picks-sealed': app.views.picksDoc('ELECTION-2026'),
    wallet: await app.views.wallet(u.address),
    proof: await app.views.proof(),
  }
  app.clock.set('2026-10-19T20:10:31Z'); await app.rounds.tick()
  live.board = await app.views.board('D-2026-10-19')
  live['pick-ok'] = { ...pk, nextAnchorAt: 'x', receipt: 'x' }
  await app.prizes.poll()
  live.prizes = app.prizes.overview()
  const problems = []
  for (const [name, v] of Object.entries(live)) {
    const f = fx(name)
    for (const p of missing(f, v)) problems.push(`${name}: fixture has ${p}, API does not`)
    for (const p of missing(v, f)) problems.push(`${name}: API has ${p}, fixture does not`)
  }
  assert.deepEqual(problems, [])
  app.stop()
})
