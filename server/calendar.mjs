// US market calendar (UTC) + TAPEWARD round plans.
// Regular session 09:30–16:00 New York time:
//   US daylight time (2nd Sunday of March → 1st Sunday of November) → 13:30–20:00 UTC (until Fri 30 Oct 2026)
//   standard time                                                   → 14:30–21:00 UTC (from Mon 2 Nov 2026)
// Rounds (rules.json):
//   daily  D-YYYY-MM-DD   lock = open, picksClose = lock − 2 min, score = close; created 24 h before lock;
//                         picks open at the previous daily round's score time (or at creation when there is none / it is later)
//   ELECTION-2026         fixed times from rules.json; opens at creation
// Round ids on chain: bytes32 = UTF-8 of the id, right-padded with zeros (viem stringToHex(id, { size: 32 })).
import { stringToHex, hexToString } from 'viem'

export const HOLIDAYS = {
  '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day',
  '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday",
}
export const EARLY_CLOSES = { '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve' }

const DAY = 86_400_000
const HOUR = 3_600_000
export const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayStart = (day) => Date.parse(day + 'T00:00:00Z')
function nthSunday(y, m, n) {
  const first = Date.UTC(y, m, 1)
  const dow = new Date(first).getUTCDay()
  return first + (((7 - dow) % 7) + (n - 1) * 7) * DAY
}
/** US Eastern daylight time in effect at instant ms (switch 02:00 local = 07:00 UTC in March, 06:00 UTC in November) */
export function isUsDst(ms) {
  const y = new Date(ms).getUTCFullYear()
  return ms >= nthSunday(y, 2, 2) + 7 * HOUR && ms < nthSunday(y, 10, 1) + 6 * HOUR
}

/** session of UTC day 'YYYY-MM-DD' → { day, tradingDay, holiday, open, close (ms | null), dst } */
export function sessionOf(day) {
  const d0 = dayStart(day)
  const dow = new Date(d0).getUTCDay()
  const dst = isUsDst(d0 + 12 * HOUR)
  const off = dst ? 4 : 5
  const holiday = HOLIDAYS[day] || null
  if (dow === 0 || dow === 6 || holiday) return { day, tradingDay: false, holiday: holiday || 'weekend', open: null, close: null, dst }
  const early = EARLY_CLOSES[day] || null
  return { day, tradingDay: true, holiday: null, earlyClose: !!early, open: d0 + ((9 + off) * 60 + 30) * 60_000, close: d0 + ((early ? 13 : 16) + off) * HOUR, dst }
}
export const isTradingDay = (day) => sessionOf(day).tradingDay
export const isOpenAt = (ms) => { const s = sessionOf(ymd(ms)); return s.tradingDay && ms >= s.open && ms < s.close }
/** first trading session whose open is > ms */
export function nextSessionAfter(ms) {
  for (let k = 0; k < 20; k++) { const s = sessionOf(ymd(ms + k * DAY)); if (s.tradingDay && s.open > ms) return s }
  return null
}
/** the session that matters at ms: today's if not closed yet, else the next one */
export function sessionAt(ms) {
  const t = sessionOf(ymd(ms))
  if (t.tradingDay && ms < t.close) return { ...t, isOpen: ms >= t.open }
  return { ...nextSessionAfter(ms), isOpen: false }
}
/** last session that has opened at or before ms (today's if open/closed already, else an earlier day) */
export function lastSessionOpened(ms) {
  for (let k = 0; k < 20; k++) { const s = sessionOf(ymd(ms - k * DAY)); if (s.tradingDay && s.open <= ms) return s }
  return null
}
export function prevTradingDay(day) {
  for (let k = 1; k < 15; k++) { const d = ymd(dayStart(day) - k * DAY); if (isTradingDay(d)) return d }
  return null
}
export function nextTradingDay(day) {
  for (let k = 1; k < 15; k++) { const d = ymd(dayStart(day) + k * DAY); if (isTradingDay(d)) return d }
  return null
}
/** n trading sessions ending with (and including) the last session that closed at or before ms */
export function lastClosedSessions(ms, n) {
  const out = []
  for (let k = 0; out.length < n && k < n * 3 + 10; k++) { const s = sessionOf(ymd(ms - k * DAY)); if (s.tradingDay && s.close <= ms) out.push(s) }
  return out
}

// ───────────────────────────── rounds
export const roundHex = (id) => stringToHex(String(id), { size: 32 })
export const roundFromHex = (hex) => hexToString(hex, { size: 32 }).replace(/\0+$/, '')
export const dailyId = (day) => `D-${day}`
export const dayOfDaily = (id) => (/^D-(\d{4}-\d{2}-\d{2})$/.exec(id) || [])[1] || null

/** plan for the daily round of trading day `day` (null when not a trading day) */
export function dailyPlan(day, rules) {
  const s = sessionOf(day)
  if (!s.tradingDay) return null
  const d = rules.daily
  const lockTime = s.open
  const createAt = lockTime - (d.create_hours_ahead ?? 24) * HOUR
  const prev = prevTradingDay(day)
  const prevExists = prev && prev >= d.first_day
  const opensAt = prevExists ? Math.max(sessionOf(prev).close, createAt) : createAt
  return {
    id: dailyId(day), kind: 'daily', day, label: `Daily · ${new Date(dayStart(day)).toUTCString().slice(0, 11).replace(',', '')}`,
    createAt, opensAt, picksClose: lockTime - (d.picks_close_minutes_before_lock ?? 2) * 60_000, lockTime, scoreTimes: [s.close], scoreLabels: d.score_labels || ['Close'],
  }
}
export function electionPlan(rules, createdAt = null) {
  const e = rules.election
  return {
    id: e.id, kind: 'election', day: ymd(Date.parse(e.lock)), label: e.label,
    createAt: createdAt ?? 0, opensAt: createdAt ?? 0, picksClose: Date.parse(e.picks_close), lockTime: Date.parse(e.lock),
    scoreTimes: e.score_times.map((t) => Date.parse(t)), scoreLabels: e.score_labels,
  }
}

/** rounds that should exist at `now` and are not in `have` (Set of ids): election (until its lock) + daily rounds whose createAt ≤ now < lock */
export function roundsDue(now, rules, have = new Set()) {
  const out = []
  const e = electionPlan(rules, now)
  if (!have.has(e.id) && now < e.picksClose) out.push(e)
  const first = rules.daily.first_day
  for (let k = -1; k <= 3; k++) {
    const day = ymd(now + k * DAY)
    if (day < first) continue
    const p = dailyPlan(day, rules)
    if (!p || have.has(p.id)) continue
    if (p.createAt <= now && now < p.picksClose) out.push(p)
  }
  return out
}

/** the next `n` daily plans from `now` (for "upcoming" views, not yet created) */
export function upcomingDaily(now, rules, n = 3) {
  const out = []
  for (let k = 0; out.length < n && k < 15; k++) {
    const day = ymd(now + k * DAY)
    if (day < rules.daily.first_day) continue
    const p = dailyPlan(day, rules)
    if (p && p.lockTime > now) out.push(p)
  }
  return out
}

/** status of a round at `now` given which score indexes are settled */
export function roundStatus(r, now, settledCount = 0) {
  if (now < r.opensAt) return 'upcoming'
  if (now < r.picksClose) return 'open'
  if (now < r.lockTime) return 'closing'
  if (settledCount >= r.scoreTimes.length) return 'settled'
  return now < r.scoreTimes[settledCount] ? 'live' : 'scoring'
}
