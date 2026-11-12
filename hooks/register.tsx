import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, TurnUsage } from 'claude-code'

import type {
  Bucket,
  GuardMode,
  HistoryRow,
  Ledger,
  Live,
  PaceSample,
  RateWindow,
  Snapshot,
  StatusStyle,
  Tab,
  View,
  Watch,
} from '../types'

const PANE = 'usage'
const TITLE = 'Usage'
const VERSION = '0.11.3'

// A warm, muted palette; it has no red, so a brick red marks "almost full".
const ORANGE = '#d97757'
const BLUE = '#6a9bcc'
const GREEN = '#788c5d'
const GRAY = '#b0aea5'
// Grey text follows the theme (the app's own muted grey), so it stays readable
// on light as well as dark; drawings can't take a theme key, so they get a
// mid grey that holds up on both.
const MUTED = 'inactive'
const MID_GRAY = '#8b887f'
const RED = '#bf4d43'
const AMBER = '#cc8a2e'
const SERIES = [ORANGE, BLUE, GREEN, GRAY]

const EMPTY: Bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const snapshot = atom({ plugin: 'usage-mod', key: 'snapshot' } as const, {
  contextWindow: 0,
  rateLimits: [],
} as Snapshot)
const ledger = atom({ plugin: 'usage-mod', key: 'ledger' } as const, {
  promptCount: 0,
  prompts: [],
  requests: 0,
  tokens: EMPTY,
  weights: EMPTY,
  main: 0,
  sub: 0,
  byModel: {},
  contexts: [],
  baseCost: 0,
} as Ledger)
const live = atom({ plugin: 'usage-mod', key: 'live' } as const, {
  isRunning: false,
  promptText: '',
  startedAt: 0,
  requests: 0,
  toolCount: 0,
  tools: [],
  tokens: EMPTY,
  weight: 0,
} as Live)
const view = atom({ plugin: 'usage-mod', key: 'view' } as const, { tab: 'session', closed: [] } as View)
const history = atom({ plugin: 'usage-mod', key: 'history' } as const, [] as HistoryRow[])
const sessionId = atom({ plugin: 'usage-mod', key: 'sessionId' } as const, '')
// Dollars a day; 0 means no budget.
const budget = atom({ plugin: 'usage-mod', key: 'budget' } as const, 0)
// How much the status line says; kept in the store across sessions.
const statusStyle = atom({ plugin: 'usage-mod', key: 'statusStyle' } as const, 'compact' as StatusStyle)
// Each rate limit's recent readings, by kind, for the forecast; this session only.
const pace = atom({ plugin: 'usage-mod', key: 'pace' } as const, {} as Record<string, PaceSample[]>)
// The guard: warn about a looping or failing tool call, stop it as well, or neither; kept in the store.
const guard = atom({ plugin: 'usage-mod', key: 'guard' } as const, 'warn' as GuardMode)
// What the guard has seen of this turn's tool calls.
const NO_WATCH: Watch = { last: '', repeats: 0, fails: {}, blocked: 0 }
const watch = atom({ plugin: 'usage-mod', key: 'watch' } as const, NO_WATCH)

const toSnapshot = (u: {
  context: SessionContextUsage
  cost?: SessionCost
  rateLimits: SessionRateLimit[]
}): Snapshot => ({
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  costUsd: u.cost?.usd,
  rateLimits: u.rateLimits,
})

// The engine reports one real total. Each request is weighed in input-token
// units by Anthropic's price ratios (output 5x, cache write 1.25x, cache read
// a per-model fraction) and its model's input price, so every share of the
// total (a prompt, a kind of token, a model) is that weight times one rate.
// Only the ratios matter: the shares still add up to the real total.
const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const
const family = (model: string) => FAMILIES.find(f => model.includes(f)) ?? model
/** The version in a model id (claude-opus-5-5 is 5.5); undefined for a bare family name. */
const versionOf = (model: string) => {
  const m = /(?:fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/.exec(model)
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 10 : undefined
}
// A bare family name means the current model of that family.
const atLeast = (model: string, v: number) => (versionOf(model) ?? Infinity) >= v

/**
 * Input $/MTok, from Anthropic's price list: Fable and Mythos 5.2 $8 (5 and
 * 5.1 $10), Opus 5.5 $4 (5 and 4.x $5), Sonnet 5.x $2 (4.x $3), Haiku 5.5
 * $0.10 (4.5 $1).
 */
const priceOf = (model: string) => {
  const fam = family(model)
  if (fam === 'fable' || fam === 'mythos') return atLeast(model, 5.2) ? 8 : 10
  if (fam === 'sonnet') return atLeast(model, 5) ? 2 : 3
  if (fam === 'haiku') return atLeast(model, 5) ? 0.1 : 1
  return atLeast(model, 5.5) ? 4 : 5
}

/** Cache reads as a fraction of input: 0.025x on Fable/Mythos 5.1+, 0.05x on Opus and Sonnet 5.5, 0.1x elsewhere. */
const cacheReadOf = (model: string) => {
  const fam = family(model)
  if (fam === 'fable' || fam === 'mythos') return atLeast(model, 5.1) ? 0.025 : 0.1
  if (fam === 'opus' || fam === 'sonnet') return atLeast(model, 5.5) ? 0.05 : 0.1
  return 0.1
}

const weigh = (u: TurnUsage): Bucket => {
  const p = priceOf(u.model)
  return {
    input: u.input_tokens * p,
    output: u.output_tokens * 5 * p,
    cacheRead: u.cache_read_input_tokens * cacheReadOf(u.model) * p,
    cacheWrite: u.cache_creation_input_tokens * 1.25 * p,
  }
}
const sum = (b: Bucket) => b.input + b.output + b.cacheRead + b.cacheWrite
const add = (a: Bucket, b: Bucket): Bucket => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
const countOf = (u: TurnUsage): Bucket => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})

// Only what was spent since tracking began is shared out: a mod loaded into a
// running session has no requests for the cost before it.
const rateOf = (s: Snapshot, l: Ledger) => {
  const w = l.main + l.sub
  return s.costUsd !== undefined && w > 0 ? Math.max(0, s.costUsd - l.baseCost) / w : undefined
}

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`

const money = (usd: number | undefined) =>
  usd === undefined ? '—' : usd >= 100 ? `$${Math.round(usd)}` : usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`

const level = (percent: number) => (percent >= 85 ? RED : percent >= 60 ? AMBER : GREEN)

const short = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const span = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(mins / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return hours > 0 ? `${hours}h${mins % 60}m` : `${mins}m`
}

/** A reset time in ms: an ISO string, or epoch seconds or milliseconds as digits. */
const parseTime = (iso: string | undefined) => {
  if (!iso) return undefined
  const at = /^[0-9]+$/.test(iso) ? Number(iso) * (iso.length <= 10 ? 1000 : 1) : Date.parse(iso)
  return Number.isFinite(at) ? at : undefined
}

const resetIn = (iso: string | undefined, now: number) => {
  const at = parseTime(iso)
  return at !== undefined && Number.isFinite(now) ? ` ↺${span(at - now)}` : ''
}

// History shows a month of sessions and stores two, so this month can be set against last month.
const DAY = 24 * 60 * 60 * 1000
const KEEP_DAYS = 30
const STORE_DAYS = 62

const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "Today", "Yesterday", else "Mon Oct 20". */
const dayLabel = (ms: number, startOfToday: number) => {
  if (ms >= startOfToday) return 'Today'
  if (ms >= startOfToday - DAY) return 'Yesterday'
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`
}

const windowLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? '$' : kind.slice(0, 3)

// The forecast: when a rate limit will be reached at the present pace, shown
// only if that comes before the limit resets.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 60 * 60 * 1000, seven_day: 7 * DAY }
// The pace is read off the last half hour once there are ten minutes of
// readings; before that, off the whole window so far.
const PACE_RECENT = 30 * 60_000
const PACE_MIN_SPAN = 10 * 60_000

type Forecast = { kind: string; eta: number; resetAt: number; isSoon: boolean }

/** Adds a reading, drops those over half an hour old, and starts afresh when the limit has reset. */
const addSample = (list: PaceSample[], pct: number, now: number): PaceSample[] => {
  const last = list[list.length - 1]
  if (last && pct < last.pct) return [{ t: now, pct }]
  const kept = list.filter(p => p.t >= now - PACE_RECENT)
  if (last && last.pct === pct && now - last.t < 60_000) return kept
  return [...kept, { t: now, pct }]
}

const forecast = (r: RateWindow, now: number, samples: PaceSample[] = []): Forecast | undefined => {
  const length = WINDOW_MS[r.kind]
  const resetAt = parseTime(r.resetsAt)
  if (!length || resetAt === undefined || !(now > 0) || resetAt <= now || r.percentUsed >= 100) return undefined
  const first = samples.find(p => p.t >= now - PACE_RECENT && p.t <= now)
  const elapsed = now - (resetAt - length)
  // Percent per millisecond.
  const rate =
    first && now - first.t >= PACE_MIN_SPAN
      ? (r.percentUsed - first.pct) / (now - first.t)
      : elapsed >= length * 0.05
        ? r.percentUsed / elapsed
        : 0
  if (!(rate > 0)) return undefined
  const eta = (100 - r.percentUsed) / rate
  // "Soon" is within a tenth of the window: 30 minutes of 5 hours.
  return now + eta < resetAt ? { kind: r.kind, eta, resetAt, isSoon: eta <= length / 10 } : undefined
}

/**
 * The status line. Compact: `ctx 17% · $11.47 · 5h 8% · 7d 6%`. A limit that
 * will be reached before it resets gains the time left: `5h 64% ⚑42m`. Full leads
 * with the limits and when they reset, then today's spend (against the budget,
 * if one is set): `5h 8% ↺3h37m · 7d 6% ↺4d8h · today $3.12/$10.00 · $11.47 · ctx 17%`.
 * The desktop footer shows only about 40 characters, so what compact lacks
 * comes first; the cost and context it cuts are in the pane beside it.
 */
const summary = (
  s: Snapshot,
  style: StatusStyle = 'compact',
  now = 0,
  today?: number,
  limit = 0,
  samples: Record<string, PaceSample[]> = {},
) => {
  const full = style === 'full'
  const ctx = s.contextPercent === undefined ? 'ctx —' : `ctx ${s.contextPercent}%`
  const cost = s.costUsd === undefined ? undefined : `$${s.costUsd.toFixed(2)}`
  const spent = full && today !== undefined ? `today ${money(today)}${limit > 0 ? `/${money(limit)}` : ''}` : undefined
  const limits = s.rateLimits.map(r => {
    const f = forecast(r, now, samples[r.kind])
    return `${windowLabel(r.kind)} ${r.percentUsed}%${f ? ` ⚑${span(f.eta)}` : ''}${full ? resetIn(r.resetsAt, now) : ''}`
  })
  const parts = full ? [...limits, spent, cost, ctx] : [ctx, cost, ...limits]
  return parts.filter(p => p !== undefined).join(' · ')
}

// The header badge: three bars of a meter. In the terminal, block characters.
const ICON_TEXT = '▂▄█'
// Bar heights out of the badge's inner height, left to right, while idle.
const ICON_BARS = [0.45, 0.7, 1]
// Pixels per unit, and the square badge it draws in. Without an explicit size
// the Svg stretches to fill its slot.
const ICON_PX = 2.5
const ICON_SIZE = 16 * ICON_PX

// Running: each bar rises and falls in turn. Idle: still.
// SMIL only, so the Svg needs isInteractive.
const iconSvg = (px: number, isRunning: boolean) => {
  const size = 16 * px
  const inner = 12 * px
  const barW = 3 * px
  const gap = px
  const left = (size - (3 * barW + 2 * gap)) / 2
  const bottom = 2 * px + inner
  const bars = ICON_BARS.map((f, i) => {
    const x = left + i * (barW + gap)
    const barH = f * inner
    const anim = isRunning
      ? `<animate attributeName="height" values="${barH};${inner * 0.3};${barH}" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"/>` +
        `<animate attributeName="y" values="${bottom - barH};${bottom - inner * 0.3};${bottom - barH}" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"/>`
      : ''
    return `<rect x="${x}" y="${bottom - barH}" width="${barW}" height="${barH}" rx="${px / 2}">${anim}</rect>`
  }).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="${ORANGE}">` +
    `<rect x="${px / 2}" y="${px / 2}" width="${size - px}" height="${size - px}" rx="${2 * px}" fill="none" stroke="${ORANGE}" stroke-opacity="0.45" stroke-width="${px / 2}"/>` +
    bars +
    `</svg>`
  )
}

const sparkSvg = (values: number[]) => {
  const w = 320
  const height = 28
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${ORANGE}" stroke-width="2" stroke-linejoin="round"/></svg>`
}

// The heatmap: a column per week, a row per weekday (Sunday on top), like /stats.
const CELL = 13
const CELL_GAP = 3
const HEAT_LEFT = 28
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Nothing, then four steps of the orange. Translucent, so the squares sit
// right on a dark or a light background alike.
// The empty step is a darker grey than the palette's, so it still shows on white.
const HEAT = ['rgba(139,136,127,0.32)', 'rgba(217,119,87,0.35)', 'rgba(217,119,87,0.55)', 'rgba(217,119,87,0.78)', ORANGE]
const HEAT_TEXT = ['·', '░', '▒', '▓', '█']

const heatLevel = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4)))

/** Where each day falls: its week column and weekday row. */
const heatCells = (values: number[], firstDay: number) => {
  const lead = new Date(firstDay).getDay()
  return values.map((v, i) => ({ v, col: Math.floor((i + lead) / 7), row: (i + lead) % 7 }))
}

const heatSvg = (values: number[], firstDay: number) => {
  const max = Math.max(...values, 0)
  const cells = heatCells(values, firstDay)
  const weeks = (cells.at(-1)?.col ?? 0) + 1
  const w = HEAT_LEFT + weeks * (CELL + CELL_GAP) - CELL_GAP
  const height = 7 * (CELL + CELL_GAP) - CELL_GAP
  const labels = [1, 3, 5]
    .map(r => `<text x="0" y="${r * (CELL + CELL_GAP) + CELL - 3}" font-size="10" fill="${MID_GRAY}" font-family="system-ui,'Segoe UI',sans-serif">${WEEKDAYS[r]}</text>`)
    .join('')
  const squares = cells
    .map(({ v, col, row }, i) => {
      const today = i === cells.length - 1
      return (
        `<rect x="${HEAT_LEFT + col * (CELL + CELL_GAP)}" y="${row * (CELL + CELL_GAP)}" width="${CELL}" height="${CELL}" rx="2.5" fill="${HEAT[heatLevel(v, max)]}"` +
        (today ? ` stroke="${MID_GRAY}" stroke-width="1.2"` : '') +
        '/>'
      )
    })
    .join('')
  return { w, height, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}">${labels}${squares}</svg>` }
}

/** The same grid in text for the terminal: one line per weekday. */
const heatText = (values: number[], firstDay: number) => {
  const max = Math.max(...values, 0)
  const cells = heatCells(values, firstDay)
  const weeks = (cells.at(-1)?.col ?? 0) + 1
  return WEEKDAYS.map((name, row) => {
    const line = Array.from({ length: weeks }, (_, col) => {
      const c = cells.find(x => x.col === col && x.row === row)
      return c ? HEAT_TEXT[heatLevel(c.v, max)] : ' '
    })
    return `${name} ${line.join(' ')}`
  })
}

/** Less ■■■■■ More: the five shades, as the heatmap draws them. */
const legendSvg = () => {
  const size = 10
  const w = HEAT.length * (size + 2) - 2
  const squares = HEAT.map((fill, i) => `<rect x="${i * (size + 2)}" y="0" width="${size}" height="${size}" rx="2" fill="${fill}"/>`)
  return { w, height: size, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}">${squares.join('')}</svg>` }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "2026-10-26", local time: a day's key for the budget alert and file names. */
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const spentToday = (rows: HistoryRow[], now: number) =>
  rows.filter(r => r.updatedAt >= startOfDay(now)).reduce((a, r) => a + r.cost, 0)

/** Weeks start on Monday. */
const startOfWeek = (ms: number) => {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

const startOfMonth = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** "C:\work\usage-mod" → "usage-mod". */
const projectName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd

/** Spend per key, largest first, the fifth and later merged into "N others" so each keeps its own colour. */
const spendBy = (rows: HistoryRow[], split: (r: HistoryRow) => [string, number][]) => {
  const sums = new Map<string, number>()
  for (const r of rows) for (const [k, c] of split(r)) sums.set(k, (sums.get(k) ?? 0) + c)
  const sorted = [...sums].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
  if (sorted.length <= 4) return sorted
  const rest = sorted.slice(3)
  return [...sorted.slice(0, 3), [`${rest.length} others`, rest.reduce((a, [, c]) => a + c, 0)] as [string, number]]
}

/**
 * Merges model entries under their family name. Before v0.9.9 a model the mod
 * didn't know (Fable) was saved under its full id; this shows it as "fable".
 */
const byFamily = (models: Record<string, number>): [string, number][] => {
  const merged: Record<string, number> = {}
  for (const [m, v] of Object.entries(models)) merged[family(m)] = (merged[family(m)] ?? 0) + v
  return Object.entries(merged)
}
const byModel = (r: HistoryRow): [string, number][] => (r.models ? byFamily(r.models) : [['not tracked', r.cost]])
const byProject = (r: HistoryRow): [string, number][] => [[r.project ? projectName(r.project) : 'not recorded', r.cost]]

/** This period so far against the one before, up to the same point in it; pct is undefined with nothing to compare. */
const periodTrend = (rows: HistoryRow[], start: number, prevStart: number, now: number) => {
  const sum = (from: number, to: number) =>
    rows.filter(r => r.updatedAt >= from && r.updatedAt < to).reduce((a, r) => a + r.cost, 0)
  const current = sum(start, Infinity)
  const previous = sum(prevStart, Math.min(prevStart + (now - start), start))
  const pct = previous > 0 ? Math.round(((current - previous) / previous) * 100) : undefined
  return { current, previous, pct }
}

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The history as CSV, oldest first, local times. */
const historyCsv = (rows: HistoryRow[]) => {
  const at = (ms: number) => `${dayKey(ms)} ${clockTime(ms)}`
  const lines = [...rows]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(r => [at(r.startedAt), at(r.updatedAt), r.cost.toFixed(4), r.prompts, r.title, r.id].map(csvCell).join(','))
  return ['started,last_active,cost_usd,prompts,title,session_id', ...lines].join('\n') + '\n'
}

/** A budget the person typed: "10", "$7.50"; 0 for "off"; undefined when it isn't one. */
const parseBudget = (args: string) => {
  const s = args.trim().toLowerCase()
  if (s === 'off' || s === 'none') return 0
  const n = Number(s.replace(/^\$/, ''))
  return Number.isFinite(n) && n >= 0 && s !== '' ? n : undefined
}

type BudgetAlert = { day: string; level: number }

// The guard warns when one call is made this many times running, or has
// failed this many times, in a turn; in stop mode it refuses the call once
// past the higher count.
const LOOP_WARN = 5
const LOOP_STOP = 8
const FAIL_WARN = 3
const FAIL_STOP = 5
const GUARD_MODES: GuardMode[] = ['warn', 'stop', 'off']

/**
 * One call's identity: its tool and a hash of its arguments, leaving out what
 * differs on every call (its id) or isn't the tool's (consent, request meta).
 */
const signature = (e: { tool: string }) => {
  const { tool_use_id: _id, consent: _consent, requestMeta: _meta, ...args } = e as Record<string, unknown>
  const text = JSON.stringify(args) ?? ''
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return `${e.tool}:${text.length}:${hash.toString(36)}`
}

const guardNote = (mode: GuardMode) =>
  mode === 'stop'
    ? `Guard is set to stop: it warns as below, then refuses a tool call made more than ${LOOP_STOP} times running or one that has failed ${FAIL_STOP} times in a turn, and every tool call once today's budget is reached.`
    : mode === 'warn'
      ? `Guard is set to warn: a toast when a tool call is made ${LOOP_WARN} times running, or fails ${FAIL_WARN} times, in a turn. Nothing is stopped.`
      : 'Guard is off.'

const sparkText = (values: number[]) => {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(1, ...values)
  return values.map(v => ticks[Math.min(7, Math.floor((v / max) * 7.99))]).join('')
}

/**
 * Writes the history to `usage-history.csv` in the working directory and returns
 * where that is. The name is fixed text in the call, and a relative path lands
 * under the session's working directory, so this is the only file the mod can write.
 */
const exportHistory = async ($: EngineInterface) => {
  const rows = await read($, history)
  await $.fs.write('usage-history.csv', historyCsv(rows))
  const cwd = await $.session.cwd()
  const sep = cwd.includes('\\') ? '\\' : '/'
  const path = `${cwd.replace(/[\\/]$/, '')}${sep}usage-history.csv`
  return { path, count: rows.length }
}

/** Toasts once at 80% and once at 100% of the daily budget, per day. */
const checkBudget = async ($: EngineInterface, rows: HistoryRow[], now: number) => {
  const limit = await read($, budget)
  if (limit <= 0) return
  const spent = spentToday(rows, now)
  const level = spent >= limit ? 100 : spent >= limit * 0.8 ? 80 : 0
  if (level === 0) return
  const day = dayKey(now)
  const last = (await $.store.get('budgetAlert').catch(() => undefined)) as BudgetAlert | null | undefined
  if (last?.day === day && last.level >= level) return
  await $.store.set('budgetAlert', { day, level } satisfies BudgetAlert)
  $.ui.toast(
    level === 100
      ? `⚑ Daily budget reached: ${money(spent)} of ${money(limit)} today`
      : `80% of today's budget used: ${money(spent)} of ${money(limit)}`,
    { timeoutMs: 8000 },
  )
}

/**
 * A turn the app starts by itself (a subagent's report, a background task's
 * notice) arrives as tagged text, not as something the person typed; name it.
 */
const promptLabel = (text: string) => {
  const tag = /^\s*<([a-z-]+)[\s>]/.exec(text)?.[1]
  if (tag === 'agent-message' || tag === 'task-notification') return '↳ subagent report'
  if (tag === 'side-sessions-event' || tag === 'ci-monitor-event') return '↳ automatic event'
  return text
}

/** Draws the status line in the chosen style, or clears it when off. */
const showStatus = async ($: EngineInterface) => {
  const style = await read($, statusStyle)
  if (style === 'off') return $.ui.status(undefined)
  const s = await read($, snapshot)
  const now = await $.clock.now()
  const samples = await read($, pace)
  if (style === 'compact') return $.ui.status(summary(s, style, now, undefined, 0, samples))
  $.ui.status(summary(s, style, now, spentToday(await read($, history), now), await read($, budget), samples))
}

/** Records each limit's reading, and toasts once per window when a limit is about to be reached. */
const checkLimits = async ($: EngineInterface, s: Snapshot, now: number) => {
  await update($, pace, p => ({
    ...p,
    ...Object.fromEntries(s.rateLimits.map(r => [r.kind, addSample(p[r.kind] ?? [], r.percentUsed, now)])),
  }))
  const samples = await read($, pace)
  const soon = s.rateLimits.map(r => forecast(r, now, samples[r.kind])).filter((f): f is Forecast => f?.isSoon === true)
  if (soon.length === 0) return
  const sent = ((await $.store.get('limitAlert').catch(() => undefined)) ?? {}) as Record<string, string>
  for (const f of soon) {
    // A window is known by when it resets, to the nearest ten minutes.
    const key = String(Math.round(f.resetAt / 600_000))
    if (sent[f.kind] === key) continue
    sent[f.kind] = key
    await $.store.set('limitAlert', sent)
    $.ui.toast(`⚑ At this pace you'll reach the ${windowLabel(f.kind)} limit in about ${span(f.eta)}`, { timeoutMs: 8000 })
  }
}

/**
 * Before a tool call runs: counts it, warns when it's the same call over and
 * over, and in stop mode answers with why the call is refused.
 */
const guardBefore = async ($: EngineInterface, e: { tool: string }) => {
  const mode = await read($, guard)
  if (mode === 'off') return undefined
  const sig = signature(e)
  const w = await read($, watch)
  const repeats = w.last === sig ? w.repeats + 1 : 1
  const refuse = async (why: string) => {
    await update($, watch, x => ({ ...x, blocked: x.blocked + 1 }))
    return `usage-mod guard: ${why}`
  }
  if (mode === 'stop') {
    const limit = await read($, budget)
    const spent = limit > 0 ? spentToday(await read($, history), await $.clock.now()) : 0
    if (limit > 0 && spent >= limit)
      return refuse(
        `today's budget of ${money(limit)} is reached (${money(spent)} spent), so tool calls are stopped. Tell the user; they can raise it with /usage-budget or lift the stop with /usage-guard warn.`,
      )
    if (repeats > LOOP_STOP)
      return refuse(`this exact ${e.tool} call has been made ${LOOP_STOP} times in a row. Don't repeat it: try something else, or ask the user.`)
    if ((w.fails[sig] ?? 0) >= FAIL_STOP)
      return refuse(`this exact ${e.tool} call has failed ${FAIL_STOP} times this turn. Don't retry it: try something else, or ask the user.`)
  }
  await update($, watch, x => ({ ...x, last: sig, repeats }))
  if (repeats === LOOP_WARN) $.ui.toast(`⚑ ${e.tool} has made the same call ${LOOP_WARN} times in a row this turn`, { timeoutMs: 8000 })
  return undefined
}

/** After a tool call failed: counts the failure, and warns when the same call keeps failing. */
const guardFailed = async ($: EngineInterface, e: { tool: string }) => {
  if ((await read($, guard)) === 'off') return
  const sig = signature(e)
  const fails = ((await read($, watch)).fails[sig] ?? 0) + 1
  await update($, watch, x => ({ ...x, fails: { ...x.fails, [sig]: fails } }))
  if (fails === FAIL_WARN) $.ui.toast(`⚑ The same ${e.tool} call has failed ${FAIL_WARN} times this turn`, { timeoutMs: 8000 })
}

const STATUS_STYLES: StatusStyle[] = ['compact', 'full', 'off']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'usage-pane', description: 'Open the usage pane' })
    await $.command.register({ name: 'usage-budget', description: 'Set a daily budget in dollars: /usage-budget 10, or off' })
    await $.command.register({ name: 'usage-export', description: 'Save the usage history as a CSV file' })
    await $.command.register({ name: 'usage-status', description: 'Status line detail: /usage-status compact, full or off' })
    await $.command.register({ name: 'usage-guard', description: 'Loop, retry and budget guard: /usage-guard warn, stop or off' })
    const storedGuard = await $.store.get('guard').catch(() => undefined)
    if (GUARD_MODES.includes(storedGuard as GuardMode)) await update($, guard, () => storedGuard as GuardMode)
    const storedBudget = await $.store.get('budget').catch(() => undefined)
    if (typeof storedBudget === 'number') await update($, budget, () => storedBudget)
    const storedStyle = await $.store.get('statusStyle').catch(() => undefined)
    if (STATUS_STYLES.includes(storedStyle as StatusStyle)) await update($, statusStyle, () => storedStyle as StatusStyle)
    const id = await $.session.id().catch(() => '')
    await update($, sessionId, () => id)
    const stored = await $.store.get('history').catch(() => undefined)
    if (Array.isArray(stored)) await update($, history, () => stored as HistoryRow[])
    const usage = await $.session.usage().catch(() => undefined)
    await update($, snapshot, () => (usage ? toSnapshot(usage) : { contextWindow: 0, rateLimits: [] }))
    await update($, ledger, l => (l.requests === 0 ? { ...l, baseCost: usage?.cost?.usd ?? 0 } : l))
    await showStatus($)
    void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('command.run', { command: 'usage-pane' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE }).catch(() => ({ isPlaced: false }))

    return {
      text: isPlaced
        ? 'Usage pane opened.'
        : 'The Usage pane is open, but no surface attached to this session is drawing it right now.',
    }
  })

  on('command.run', { command: 'usage-budget' }, async ($, e) => {
    const value = parseBudget(e.args)
    if (value === undefined) {
      const limit = await read($, budget)
      const spent = spentToday(await read($, history), await $.clock.now())
      return {
        text:
          limit > 0
            ? `Daily budget is ${money(limit)}; ${money(spent)} spent today. Change it with /usage-budget 15, or turn it off with /usage-budget off.`
            : 'No daily budget set. Set one with /usage-budget 10.',
      }
    }
    await update($, budget, () => value)
    await $.store.set('budget', value)
    // A new budget gets its own alerts.
    await $.store.set('budgetAlert', null)
    if (value > 0) await checkBudget($, await read($, history), await $.clock.now())
    await showStatus($)
    return { text: value > 0 ? `Daily budget set to ${money(value)}. You'll get a toast at 80% and 100%.` : 'Daily budget turned off.' }
  })

  on('command.run', { command: 'usage-status' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const current = await read($, statusStyle)
    // No argument flips between compact and full.
    const next = arg === '' ? (current === 'full' ? 'compact' : 'full') : (arg as StatusStyle)
    if (!STATUS_STYLES.includes(next)) return { text: `Unknown style "${arg}". Use /usage-status compact, full or off.` }
    await update($, statusStyle, () => next)
    await $.store.set('statusStyle', next)
    await showStatus($)
    return {
      text:
        next === 'off'
          ? 'Status line turned off. Bring it back with /usage-status compact or full.'
          : `Status line set to ${next}.`,
    }
  })

  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') return { text: `${guardNote(await read($, guard))} Change it with /usage-guard warn, stop or off.` }
    if (!GUARD_MODES.includes(arg as GuardMode)) return { text: `Unknown mode "${arg}". Use /usage-guard warn, stop or off.` }
    await update($, guard, () => arg as GuardMode)
    await $.store.set('guard', arg)
    return { text: guardNote(arg as GuardMode) }
  })

  on('command.run', { command: 'usage-export' }, async $ => {
    const { path, count } = await exportHistory($)
    return { text: `Saved ${count} session${count === 1 ? '' : 's'} to ${path}` }
  })

  on('session.measure', async ($, e, next) => {
    const s = toSnapshot(e)
    await update($, snapshot, () => s)

    // Keep this session's row in the history, newest first, across sessions.
    try {
      const id = await read($, sessionId)
      const l = await read($, ledger)
      const now = await $.clock.now()
      if (id && s.costUsd !== undefined) {
        const rows = await read($, history)
        const old = rows.find(r => r.id === id)
        const project = old?.project || (await $.session.cwd().catch(() => ''))
        // The session's real cost, split by each model's share of the weighed requests.
        const weighed = Object.values(l.byModel).reduce((a, w) => a + w, 0)
        const cost = s.costUsd
        const models =
          weighed > 0 ? Object.fromEntries(Object.entries(l.byModel).map(([m, w]) => [m, (cost * w) / weighed])) : old?.models
        const row: HistoryRow = {
          id,
          startedAt: old?.startedAt ?? (await $.session.usage()).startedAt,
          updatedAt: now,
          cost,
          prompts: l.promptCount,
          title: old?.title || short(l.prompts[0]?.text ?? '', 60),
          ...(project ? { project } : {}),
          ...(models ? { models } : {}),
        }
        const kept = [row, ...rows.filter(r => r.id !== id && r.updatedAt >= now - STORE_DAYS * DAY)].slice(0, 500)
        await update($, history, () => kept)
        await $.store.set('history', kept)
        await checkBudget($, kept, now)
      }
    } catch {
      // History is a convenience; a failed write never holds up the session.
    }
    // The forecast is a convenience too.
    await checkLimits($, s, await $.clock.now()).catch(() => undefined)
    // After the history, so "today" in the full style includes this request.
    await showStatus($).catch(() => undefined)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      const text = promptLabel(e.text)
      await update($, ledger, l => ({
        ...l,
        promptCount: l.promptCount + 1,
        prompts: [...l.prompts, { n: l.promptCount + 1, text: short(text, 120), requests: 0, weight: 0 }].slice(-50),
      })).catch(() => undefined)
      await update($, live, () => ({
        isRunning: true,
        promptText: short(text, 200),
        startedAt: now,
        requests: 0,
        toolCount: 0,
        tools: [],
        tokens: EMPTY,
        weight: 0,
      })).catch(() => undefined)
      await update($, watch, () => NO_WATCH).catch(() => undefined)
    }

    return next(e)
  })

  // turn.step streams the response; forward it untouched and count its usage.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const usage = r.usage
    if (usage) {
      const w = weigh(usage)
      const ws = sum(w)
      const n = countOf(usage)
      const isMain = !e.agentId
      const fam = family(usage.model || e.model)
      await update($, ledger, l => {
        const last = l.prompts[l.prompts.length - 1]
        return {
          ...l,
          requests: l.requests + 1,
          tokens: add(l.tokens, n),
          weights: add(l.weights, w),
          main: l.main + (isMain ? ws : 0),
          sub: l.sub + (isMain ? 0 : ws),
          byModel: { ...l.byModel, [fam]: (l.byModel[fam] ?? 0) + ws },
          contexts: isMain ? [...l.contexts, n.input + n.cacheRead + n.cacheWrite].slice(-20) : l.contexts,
          prompts: last
            ? [...l.prompts.slice(0, -1), { ...last, requests: last.requests + 1, weight: last.weight + ws }]
            : l.prompts,
        }
      }).catch(() => undefined)
      await update($, live, v => ({ ...v, requests: v.requests + 1, tokens: add(v.tokens, n), weight: v.weight + ws })).catch(
        () => undefined,
      )
    }

    return r
  })

  on('tool.call', async ($, e, next) => {
    await update($, live, v => ({ ...v, toolCount: v.toolCount + 1, tools: [...v.tools, e.tool].slice(-8) })).catch(
      () => undefined,
    )

    // The guard never holds up a call by failing: an error in it lets the call through.
    const why = await guardBefore($, e).catch(() => undefined)
    if (why) return { deny: why }
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) await guardFailed($, e).catch(() => undefined)

    return ran
  }).catch((_, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now().catch(() => 0)
      await update($, live, v => ({ ...v, isRunning: false, endedAt: now })).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const bodyRows = e.props.scroll?.bodyRows
    const columns = e.props.bodyColumns ?? 40
    const barWidth = Math.max(8, Math.min(60, columns - 20))

    const s = await read($, snapshot)
    const l = await read($, ledger)
    const v = await read($, view)
    const lv = await read($, live)
    const w = await read($, watch)
    const rows = await read($, history)
    const id = await read($, sessionId)
    const now = await $.clock.now()
    const rate = rateOf(s, l)
    const isPlan = s.rateLimits.length > 0
    const limit = await read($, budget)

    const setTab = (tab: Tab) => update($, view, x => ({ ...x, tab }))
    const toggle = (name: string) =>
      update($, view, x => ({
        ...x,
        closed: x.closed.includes(name) ? x.closed.filter(c => c !== name) : [...x.closed, name],
      }))
    const isOpen = (name: string) => !v.closed.includes(name)

    // A desktop's proportional font fits fewer glyphs than bodyColumns reports,
    // so leave it slack; and size each bar around its own right-hand text, or
    // a long one ("15% ↺3h37m") wraps under the bar.
    const meterRoom = e.surface === 'terminal' ? columns : Math.floor(columns * 0.8)
    const meter = (label: string, percent: number, right: string, rightRoom = right.length) => {
      const barWidth = Math.max(6, Math.min(60, meterRoom - 4 - Math.max(rightRoom, right.length) - 2))
      const full = Math.max(percent > 0 ? 1 : 0, Math.round((Math.min(100, percent) / 100) * barWidth))
      return (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={BLUE} bold>
              {label.padEnd(4)}
            </Text>
            <Text color={level(percent)}>{'█'.repeat(full)}</Text>
            <Text color={MUTED}>{'─'.repeat(barWidth - full)}</Text>
          </Text>
          <Box flexShrink={0}>
            <Text color={level(percent)} bold>
              {right}
            </Text>
          </Box>
        </Box>
      )
    }

    const stacked = (parts: { share: number; color: string }[]) => {
      let used = 0
      return (
        <Text>
          {parts.map((p, i) => {
            const cells = i === parts.length - 1 ? barWidth + 4 - used : Math.round(p.share * (barWidth + 4))
            used += cells
            return <Text color={p.color}>{'█'.repeat(Math.max(0, cells))}</Text>
          })}
        </Text>
      )
    }

    const section = (name: string, label: string, icon: string) => (
      <Box>
        <Text color={MUTED}>{icon} </Text>
        <Button key={`sec-${name}`} plain label={`${isOpen(name) ? '▾' : '▸'} ${label}`} onPress={() => toggle(name)} />
      </Box>
    )

    const header = (
      <Box gap={2} alignItems="center">
        {Svg ? (
          <Svg
            key={lv.isRunning ? 'icon-running' : 'icon-idle'}
            source={iconSvg(ICON_PX, lv.isRunning)}
            width={ICON_SIZE}
            height={ICON_SIZE}
            alt={lv.isRunning ? 'Usage meter, moving while Claude works' : 'Usage meter'}
            isInteractive
          />
        ) : (
          <Text color={ORANGE}>{ICON_TEXT}</Text>
        )}
        {(['session', 'live', 'history'] as const).map((tab, i) => (
          <Button
            key={`tab-${tab}`}
            plain
            hotkey={String(i + 1)}
            label={tab === 'session' ? 'Session' : tab === 'live' ? 'Live' : 'History'}
            dimColor={v.tab !== tab}
            onPress={() => setTab(tab)}
          />
        ))}
      </Box>
    )

    // The bars share one width, set by the longest right-hand text, so their
    // ends line up.
    const ctxRight = `${s.contextPercent}% ${fmt(s.contextTokens ?? 0)}/${fmt(s.contextWindow)}`
    const limitRights = s.rateLimits.map(r => `${r.percentUsed}%${resetIn(r.resetsAt, now)}`)
    const samples = await read($, pace)
    const forecasts = s.rateLimits.map(r => forecast(r, now, samples[r.kind])).filter((f): f is Forecast => f !== undefined)
    const rightRoom = Math.max(0, ...[s.contextPercent !== undefined ? ctxRight : '', ...limitRights].map(t => t.length))
    const limits = (
      <Box flexDirection="column">
        {s.contextPercent !== undefined && meter('ctx', s.contextPercent, ctxRight, rightRoom)}
        {s.rateLimits.map((r, i) => meter(windowLabel(r.kind), r.percentUsed, limitRights[i] ?? '', rightRoom))}
        {forecasts.map(f => (
          <Text color={f.isSoon ? RED : AMBER}>
            ⚑ {windowLabel(f.kind)} limit in ~{span(f.eta)} at this pace (resets in {span(f.resetAt - now)})
          </Text>
        ))}
      </Box>
    )

    const sessionTab = () => {
      const recent = [...l.prompts].reverse().slice(0, 6)
      const top = l.prompts.reduce<(typeof l.prompts)[number] | undefined>((a, p) => (!a || p.weight > a.weight ? p : a), undefined)
      const total = l.main + l.sub
      const models = byFamily(l.byModel).sort((a, b) => b[1] - a[1])
      const kinds = [
        { label: 'new input', color: BLUE, tokens: l.tokens.input, weight: l.weights.input },
        { label: 'cache read', color: GREEN, tokens: l.tokens.cacheRead, weight: l.weights.cacheRead },
        { label: 'cache write', color: GRAY, tokens: l.tokens.cacheWrite, weight: l.weights.cacheWrite },
        { label: 'output', color: ORANGE, tokens: l.tokens.output, weight: l.weights.output },
      ]
      const mainFamily = models[0]?.[0] ?? 'opus'
      const perRequest =
        s.contextTokens !== undefined && rate !== undefined ? s.contextTokens * cacheReadOf(mainFamily) * priceOf(mainFamily) * rate : undefined

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text color={ORANGE} bold>
                {money(s.costUsd)}
              </Text>
              <Text color={MUTED}>{isPlan ? ' ≈ API value' : ' spent this session'}</Text>
            </Text>
            {limits}
          </Box>

          <Box flexDirection="column">
            {section('prompts', `Prompts (${l.promptCount})`, '◷')}
            {isOpen('prompts') && (
              <Box flexDirection="column">
                {top && (
                  <Text bold>
                    Most expensive: prompt #{top.n}
                    <Text color={MUTED}> {money(rate === undefined ? undefined : top.weight * rate)}</Text>
                  </Text>
                )}
                {recent.length === 0 && <Text color={MUTED}>No prompts yet.</Text>}
                {recent.map((p, i) => (
                  <Box justifyContent="space-between" gap={1}>
                    <Text wrap="truncate-end">
                      <Text color={i === 0 && lv.isRunning ? GREEN : MUTED}>● </Text>
                      {p.text ? short(p.text, 60) : `prompt #${p.n}`}
                    </Text>
                    <Box flexShrink={0}>
                      <Text color={MUTED}>
                        {p.requests}× {money(rate === undefined ? undefined : p.weight * rate)}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          <Box flexDirection="column">
            {section('breakdown', 'Breakdown', '▥')}
            {isOpen('breakdown') && total > 0 && (
              <Box flexDirection="column">
                {stacked([
                  { share: l.main / total, color: ORANGE },
                  { share: l.sub / total, color: BLUE },
                ])}
                <Text>
                  <Text color={ORANGE}>■ </Text>Main {Math.round((l.main / total) * 100)}% {money(rate === undefined ? undefined : l.main * rate)}
                  <Text color={MUTED}> · </Text>
                  <Text color={BLUE}>■ </Text>Subagents {Math.round((l.sub / total) * 100)}% {money(rate === undefined ? undefined : l.sub * rate)}
                </Text>
                {stacked(models.map(([, w], i) => ({ share: w / total, color: SERIES[i % SERIES.length] ?? GRAY })))}
                <Text wrap="truncate-end">
                  {models.map(([name, w], i) => (
                    <Text>
                      {i > 0 && <Text color={MUTED}> · </Text>}
                      <Text color={SERIES[i % SERIES.length] ?? GRAY}>■ </Text>
                      {name} {Math.round((w / total) * 100)}% {money(rate === undefined ? undefined : w * rate)}
                    </Text>
                  ))}
                </Text>
              </Box>
            )}
            {isOpen('breakdown') && total === 0 && <Text color={MUTED}>Nothing measured yet.</Text>}
          </Box>

          <Box flexDirection="column">
            {section('tokens', 'Tokens', '∿')}
            {isOpen('tokens') && (
              <Box flexDirection="column">
                {kinds.map(k => (
                  <Box justifyContent="space-between" gap={1}>
                    <Text>
                      <Text color={k.color}>■ </Text>
                      {k.label}
                    </Text>
                    <Text color={MUTED}>
                      {fmt(k.tokens)} {money(rate === undefined ? undefined : k.weight * rate)}
                    </Text>
                  </Box>
                ))}
                {l.contexts.length > 1 && (
                  <Box gap={1} alignItems="center">
                    <Text color={MUTED}>last {l.contexts.length}</Text>
                    {Svg ? (
                      <Svg source={sparkSvg(l.contexts)} alt="Context size of the recent requests" />
                    ) : (
                      <Text color={ORANGE}>{sparkText(l.contexts)}</Text>
                    )}
                  </Box>
                )}
              </Box>
            )}
          </Box>

          {(s.contextTokens ?? 0) >= 100_000 && (
            <Text color={AMBER}>
              ⚑ ~{fmt(s.contextTokens ?? 0)} tokens of context per request
              {perRequest !== undefined ? `, ≈${money(perRequest)} each` : ''} — /compact or a new session would cut this
            </Text>
          )}
          {isPlan && <Text color={MUTED}>Your plan isn't billed per token; these are API-price estimates.</Text>}
        </Box>
      )
    }

    const liveTab = () => {
      const elapsed = lv.startedAt ? (lv.isRunning ? now : lv.endedAt ?? now) - lv.startedAt : 0
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text color={lv.isRunning ? GREEN : MUTED} bold>
                {lv.isRunning ? '● Working' : '○ Idle'}
              </Text>
              {lv.startedAt > 0 && (
                <Text color={MUTED}>
                  {' '}
                  · {lv.isRunning ? 'running' : 'last turn took'} {Math.round(elapsed / 1000)}s
                </Text>
              )}
            </Text>
            {lv.promptText ? <Text wrap="truncate-end">{lv.promptText}</Text> : <Text color={MUTED}>No turn yet.</Text>}
          </Box>

          {limits}

          {w.blocked > 0 && (
            <Text color={RED}>
              ⚑ Guard stopped {w.blocked} tool call{w.blocked === 1 ? '' : 's'} this turn
            </Text>
          )}

          <Box flexDirection="column">
            <Text color={ORANGE} bold>
              This turn
            </Text>
            <Text>
              {lv.requests} requests · {lv.toolCount} tool calls ·{' '}
              <Text color={ORANGE}>≈{money(rate === undefined ? undefined : lv.weight * rate)}</Text>
            </Text>
            <Text color={MUTED}>
              in {fmt(lv.tokens.input)} · cache read {fmt(lv.tokens.cacheRead)} · cache write {fmt(lv.tokens.cacheWrite)} · out{' '}
              {fmt(lv.tokens.output)}
            </Text>
          </Box>

          <Box flexDirection="column">
            <Text color={BLUE} bold>
              Recent tools
            </Text>
            {lv.tools.length === 0 && <Text color={MUTED}>None this turn.</Text>}
            {[...lv.tools].reverse().map((tool, i) => (
              <Text color={i === 0 && lv.isRunning ? GREEN : MUTED}>
                {i === 0 && lv.isRunning ? '▶ ' : '· '}
                {tool}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }

    const historyTab = () => {
      const startOfToday = (() => {
        const d = new Date(now)
        d.setHours(0, 0, 0, 0)
        return d.getTime()
      })()
      const recent = rows.filter(r => r.updatedAt >= now - KEEP_DAYS * DAY)
      const total = (since: number) => recent.filter(r => r.updatedAt >= since).reduce((a, r) => a + r.cost, 0)
      // One group per day, newest first, each with its own total.
      const days: { label: string; cost: number; rows: HistoryRow[] }[] = []
      for (const r of recent) {
        const label = dayLabel(r.updatedAt, startOfToday)
        const group = days.find(g => g.label === label)
        if (group) {
          group.rows.push(r)
          group.cost += r.cost
        } else days.push({ label, cost: r.cost, rows: [r] })
      }

      // Cost per calendar day, the last KEEP_DAYS days, today last.
      const firstDay = startOfToday - (KEEP_DAYS - 1) * DAY
      const daily = Array.from({ length: KEEP_DAYS }, () => 0)
      for (const r of recent) {
        const i = Math.floor((r.updatedAt - firstDay) / DAY)
        if (i >= 0 && i < KEEP_DAYS) daily[i] = (daily[i] ?? 0) + r.cost
      }
      const active = daily.filter(c => c > 0).length
      const peak = daily.reduce((best, c, i) => (c > (daily[best] ?? 0) ? i : best), 0)
      const streak = (() => {
        // Counted back from today, or from yesterday if today has nothing yet.
        let i = (daily[KEEP_DAYS - 1] ?? 0) > 0 ? KEEP_DAYS - 1 : KEEP_DAYS - 2
        let n = 0
        while (i >= 0 && (daily[i] ?? 0) > 0) (n++, i--)
        return n
      })()
      const heat = heatSvg(daily, firstDay)
      const legend = legendSvg()
      const today = total(startOfToday)
      const weekStart = startOfWeek(now)
      const monthStart = startOfMonth(now)
      const lastMonthStart = (() => {
        const d = new Date(monthStart)
        d.setMonth(d.getMonth() - 1)
        return d.getTime()
      })()
      const lastWeekStart = (() => {
        const d = new Date(weekStart)
        d.setDate(d.getDate() - 7)
        return d.getTime()
      })()
      // The amount and its arrow share the trend's colour: red for a big rise, amber for
      // a small one (under 10%), green for a fall, the period's own colour when there's no trend.
      const trendLine = (label: string, period: string, t: ReturnType<typeof periodTrend>, color: string) => {
        const tone = t.pct === undefined || t.pct === 0 ? color : t.pct >= 10 ? RED : t.pct > 0 ? AMBER : GREEN
        return (
          <Text key={period}>
            <Text color={MUTED}>{label} </Text>
            <Text color={tone} bold>
              {money(t.current)}
            </Text>
            <Text color={MUTED}> · </Text>
            {t.pct === undefined ? (
              <Text color={MUTED}>no spend last {period} to compare</Text>
            ) : t.pct > 0 ? (
              <Text color={tone} bold>
                ▲ {t.pct}% vs last {period}
              </Text>
            ) : t.pct < 0 ? (
              <Text color={tone} bold>
                ▼ {-t.pct}% vs last {period}
              </Text>
            ) : (
              <Text color={MUTED}>= same as last {period}</Text>
            )}
          </Text>
        )
      }
      const trends = (
        <Box flexDirection="column">
          {trendLine('This week', 'week', periodTrend(rows, weekStart, lastWeekStart, now), BLUE)}
          {trendLine('This month', 'month', periodTrend(rows, monthStart, lastMonthStart, now), GREEN)}
          <Text color={MUTED}>Compared with the same point last week and last month.</Text>
        </Box>
      )
      const thisWeek = rows.filter(r => r.updatedAt >= weekStart)
      const split = (name: string, label: string, icon: string, parts: [string, number][]) => {
        const sum = parts.reduce((a, [, c]) => a + c, 0)
        const color = (i: number) => SERIES[i % SERIES.length] ?? GRAY
        return (
          <Box flexDirection="column">
            {section(name, label, icon)}
            {isOpen(name) &&
              (sum > 0 ? (
                <Box flexDirection="column">
                  {stacked(parts.map(([, c], i) => ({ share: c / sum, color: color(i) })))}
                  {parts.map(([key, c], i) => (
                    <Box key={key} justifyContent="space-between" gap={1}>
                      <Text wrap="truncate-end">
                        <Text color={color(i)}>■ </Text>
                        {key}
                      </Text>
                      <Box flexShrink={0}>
                        <Text color={MUTED}>
                          {Math.round((c / sum) * 100)}% <Text color={ORANGE}>{money(c)}</Text>
                        </Text>
                      </Box>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Text color={MUTED}>No spend this week yet.</Text>
              ))}
          </Box>
        )
      }
      const budgetLine =
        limit > 0 ? (
          meter('day', Math.round((today / limit) * 100), `${money(today)} / ${money(limit)}`)
        ) : (
          <Text color={MUTED}>No daily budget · set one with /usage-budget 10</Text>
        )
      const stat = (label: string, value: string, color: string) => (
        <Text>
          <Text color={MUTED}>{label} </Text>
          <Text color={color} bold>
            {value}
          </Text>
        </Text>
      )
      const stats = (
        <Box flexDirection="column">
          <Text bold>Activity, last {KEEP_DAYS} days</Text>
          {Svg ? (
            <Svg
              source={heat.source}
              width={heat.w}
              height={heat.height}
              alt={`Cost heatmap for the last ${KEEP_DAYS} days, busiest ${money(daily[peak] ?? 0)}`}
            />
          ) : (
            <Box flexDirection="column">
              {heatText(daily, firstDay).map(line => (
                <Text key={line.slice(0, 3)} color={ORANGE}>
                  {line}
                </Text>
              ))}
            </Box>
          )}
          <Box gap={1} alignItems="center">
            <Text color={MUTED}>{dayLabel(firstDay, startOfToday)} → Today · Less</Text>
            {Svg ? (
              <Svg source={legend.source} width={legend.w} height={legend.height} alt="From no spend to the most" />
            ) : (
              <Text color={ORANGE}>{HEAT_TEXT.join('')}</Text>
            )}
            <Text color={MUTED}>More</Text>
          </Box>
          <Box gap={2} flexWrap="wrap">
            {stat('Active days', `${active}/${KEEP_DAYS}`, GREEN)}
            {stat('Streak', `${streak}d`, AMBER)}
            {stat('Busiest', active > 0 ? `${dayLabel(firstDay + peak * DAY, startOfToday)} ${money(daily[peak] ?? 0)}` : '—', ORANGE)}
            {stat('Avg/active day', active > 0 ? money(total(firstDay) / active) : '—', BLUE)}
          </Box>
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text color={MUTED}>Today </Text>
              <Text color={ORANGE} bold>
                {money(today)}
              </Text>
              <Text color={MUTED}> · 7 days </Text>
              <Text color={BLUE} bold>
                {money(total(now - 7 * DAY))}
              </Text>
              <Text color={MUTED}> · 30 days </Text>
              <Text color={GREEN} bold>
                {money(total(now - KEEP_DAYS * DAY))}
              </Text>
            </Text>
            {trends}
            <Box gap={2} alignItems="center">
              <Text color={MUTED}>
                {recent.length} session{recent.length === 1 ? '' : 's'} in the last {KEEP_DAYS} days
              </Text>
              <Button
                key="export"
                variant="primary"
                onPress={async () => {
                  const { path } = await exportHistory($).catch(() => ({ path: '' }))
                  $.ui.toast(path ? `Saved ${path}` : 'Export failed', { timeoutMs: 8000 })
                }}
              >
                <Text color={BLUE} bold>
                  ⇩ Export CSV
                </Text>
              </Button>
            </Box>
            {budgetLine}
          </Box>

          {stats}

          {split('week-models', 'This week by model', '▥', spendBy(thisWeek, byModel))}
          {split('week-projects', 'This week by project', '▤', spendBy(thisWeek, byProject))}

          {recent.length === 0 && <Text color={MUTED}>No sessions recorded yet.</Text>}
          {days.map(g => (
            <Box key={g.label} flexDirection="column">
              <Box justifyContent="space-between" gap={1}>
                <Text color={BLUE} bold>
                  {g.label}
                </Text>
                <Text color={ORANGE} bold>
                  {money(g.cost)}
                </Text>
              </Box>
              {g.rows.map(r => (
                <Box key={r.id} justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end">
                    <Text color={r.id === id ? GREEN : MUTED}>{r.id === id ? '● ' : '· '}</Text>
                    <Text color={MUTED}>{clockTime(r.startedAt)} </Text>
                    {r.title || 'Untitled session'}
                  </Text>
                  <Box flexShrink={0}>
                    <Text color={MUTED}>
                      {r.prompts}p <Text color={ORANGE}>{money(r.cost)}</Text>
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ))}
          {isPlan && <Text color={MUTED}>Costs are API-price estimates; your plan isn't billed per token.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" minHeight={bodyRows} justifyContent="space-between">
        <Box flexDirection="column" gap={1}>
          {header}
          {v.tab === 'session' ? sessionTab() : v.tab === 'live' ? liveTab() : historyTab()}
        </Box>
        <Text color={MUTED}>usage-mod v{VERSION}</Text>
      </Box>
    )
  })
}
