import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, TurnUsage } from 'claude-code'

import type { Bucket, HistoryRow, Ledger, Live, Snapshot, Tab, View } from '../types'

const PANE = 'usage'
const TITLE = 'Usage'
const VERSION = '0.9.0'

// A warm, muted palette; it has no red, so a brick red marks "almost full".
const ORANGE = '#d97757'
const BLUE = '#6a9bcc'
const GREEN = '#788c5d'
const GRAY = '#b0aea5'
const RED = '#bf4d43'
const AMBER = '#e0a548'
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
// units by Anthropic's price ratios (cache read 0.1x, cache write 1.25x,
// output 5x) and its model's relative input price, so every share of the
// total (a prompt, a kind of token, a model) is that weight times one rate.
const family = (model: string) =>
  model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : model
const priceOf = (fam: string) => (fam === 'haiku' ? 1 : fam === 'sonnet' ? 3 : 5)

const weigh = (u: TurnUsage): Bucket => {
  const p = priceOf(family(u.model))
  return {
    input: u.input_tokens * p,
    output: u.output_tokens * 5 * p,
    cacheRead: u.cache_read_input_tokens * 0.1 * p,
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
  const h = Math.floor(mins / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`
  return h > 0 ? `${h}h${mins % 60}m` : `${mins}m`
}

const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const at = /^[0-9]+$/.test(iso) ? Number(iso) * (iso.length <= 10 ? 1000 : 1) : Date.parse(iso)
  return Number.isFinite(at) && Number.isFinite(now) ? ` ↺${span(at - now)}` : ''
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

const summary = (s: Snapshot) => {
  const parts = [s.contextPercent === undefined ? 'ctx —' : `ctx ${s.contextPercent}%`]
  if (s.costUsd !== undefined) parts.push(`$${s.costUsd.toFixed(2)}`)
  for (const r of s.rateLimits) parts.push(`${windowLabel(r.kind)} ${r.percentUsed}%`)
  return parts.join(' · ')
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
    const h = f * inner
    const anim = isRunning
      ? `<animate attributeName="height" values="${h};${inner * 0.3};${h}" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"/>` +
        `<animate attributeName="y" values="${bottom - h};${bottom - inner * 0.3};${bottom - h}" dur="0.9s" begin="${i * 0.15}s" repeatCount="indefinite"/>`
      : ''
    return `<rect x="${x}" y="${bottom - h}" width="${barW}" height="${h}" rx="${px / 2}">${anim}</rect>`
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
  const h = 28
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${ORANGE}" stroke-width="2" stroke-linejoin="round"/></svg>`
}

// The heatmap: a column per week, a row per weekday (Sunday on top), like /stats.
const CELL = 13
const CELL_GAP = 3
const HEAT_LEFT = 28
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Nothing, then four steps of the orange. Translucent, so the squares sit
// right on a dark or a light background alike.
const HEAT = ['rgba(176,174,165,0.22)', 'rgba(217,119,87,0.35)', 'rgba(217,119,87,0.55)', 'rgba(217,119,87,0.78)', ORANGE]
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
  const h = 7 * (CELL + CELL_GAP) - CELL_GAP
  const labels = [1, 3, 5]
    .map(r => `<text x="0" y="${r * (CELL + CELL_GAP) + CELL - 3}" font-size="10" fill="${GRAY}" font-family="system-ui,'Segoe UI',sans-serif">${WEEKDAYS[r]}</text>`)
    .join('')
  const squares = cells
    .map(({ v, col, row }, i) => {
      const today = i === cells.length - 1
      return (
        `<rect x="${HEAT_LEFT + col * (CELL + CELL_GAP)}" y="${row * (CELL + CELL_GAP)}" width="${CELL}" height="${CELL}" rx="2.5" fill="${HEAT[heatLevel(v, max)]}"` +
        (today ? ` stroke="${GRAY}" stroke-width="1.2"` : '') +
        '/>'
      )
    })
    .join('')
  return { w, h, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${labels}${squares}</svg>` }
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
  return { w, h: size, source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}">${squares.join('')}</svg>` }
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

const byModel = (r: HistoryRow): [string, number][] => (r.models ? Object.entries(r.models) : [['not tracked', r.cost]])
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

const sparkText = (values: number[]) => {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(1, ...values)
  return values.map(v => ticks[Math.min(7, Math.floor((v / max) * 7.99))]).join('')
}

/** Writes the history to a CSV in the working directory and returns its path. */
const exportHistory = async ($: EngineInterface) => {
  const rows = await read($, history)
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const sep = cwd.includes('\\') ? '\\' : '/'
  const path = `${cwd.replace(/[\\/]$/, '')}${sep}usage-history-${dayKey(now)}.csv`
  await $.fs.write(path, historyCsv(rows))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'usage-pane', description: 'Open the usage pane' })
    await $.command.register({ name: 'usage-budget', description: 'Set a daily budget in dollars: /usage-budget 10, or off' })
    await $.command.register({ name: 'usage-export', description: 'Save the usage history as a CSV file' })
    const storedBudget = await $.store.get('budget').catch(() => undefined)
    if (typeof storedBudget === 'number') await update($, budget, () => storedBudget)
    const id = await $.session.id().catch(() => '')
    await update($, sessionId, () => id)
    const stored = await $.store.get('history').catch(() => undefined)
    if (Array.isArray(stored)) await update($, history, () => stored as HistoryRow[])
    const usage = await $.session.usage().catch(() => undefined)
    await update($, snapshot, () => (usage ? toSnapshot(usage) : { contextWindow: 0, rateLimits: [] }))
    await update($, ledger, l => (l.requests === 0 ? { ...l, baseCost: usage?.cost?.usd ?? 0 } : l))
    $.ui.status(summary(await read($, snapshot)))
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
    return { text: value > 0 ? `Daily budget set to ${money(value)}. You'll get a toast at 80% and 100%.` : 'Daily budget turned off.' }
  })

  on('command.run', { command: 'usage-export' }, async $ => {
    const { path, count } = await exportHistory($)
    return { text: `Saved ${count} session${count === 1 ? '' : 's'} to ${path}` }
  })

  on('session.measure', async ($, e, next) => {
    const s = toSnapshot(e)
    await update($, snapshot, () => s)
    $.ui.status(summary(s))

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

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, ledger, l => ({
        ...l,
        promptCount: l.promptCount + 1,
        prompts: [...l.prompts, { n: l.promptCount + 1, text: short(e.text, 120), requests: 0, weight: 0 }].slice(-50),
      })).catch(() => undefined)
      await update($, live, () => ({
        isRunning: true,
        promptText: short(e.text, 200),
        startedAt: now,
        requests: 0,
        toolCount: 0,
        tools: [],
        tokens: EMPTY,
        weight: 0,
      })).catch(() => undefined)
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

    return next(e)
  })

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

    const meter = (label: string, percent: number, right: string) => {
      const full = Math.max(percent > 0 ? 1 : 0, Math.round((Math.min(100, percent) / 100) * barWidth))
      return (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={BLUE} bold>
              {label.padEnd(4)}
            </Text>
            <Text color={level(percent)}>{'█'.repeat(full)}</Text>
            <Text color={GRAY}>{'─'.repeat(barWidth - full)}</Text>
          </Text>
          <Text color={level(percent)} bold>
            {right}
          </Text>
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
        <Text color={GRAY}>{icon} </Text>
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

    const limits = (
      <Box flexDirection="column">
        {s.contextPercent !== undefined &&
          meter('ctx', s.contextPercent, `${s.contextPercent}% ${fmt(s.contextTokens ?? 0)}/${fmt(s.contextWindow)}`)}
        {s.rateLimits.map(r => meter(windowLabel(r.kind), r.percentUsed, `${r.percentUsed}%${resetIn(r.resetsAt, now)}`))}
      </Box>
    )

    const sessionTab = () => {
      const recent = [...l.prompts].reverse().slice(0, 6)
      const top = l.prompts.reduce<(typeof l.prompts)[number] | undefined>((a, p) => (!a || p.weight > a.weight ? p : a), undefined)
      const total = l.main + l.sub
      const models = Object.entries(l.byModel).sort((a, b) => b[1] - a[1])
      const kinds = [
        { label: 'new input', color: BLUE, tokens: l.tokens.input, weight: l.weights.input },
        { label: 'cache read', color: GREEN, tokens: l.tokens.cacheRead, weight: l.weights.cacheRead },
        { label: 'cache write', color: GRAY, tokens: l.tokens.cacheWrite, weight: l.weights.cacheWrite },
        { label: 'output', color: ORANGE, tokens: l.tokens.output, weight: l.weights.output },
      ]
      const mainFamily = models[0]?.[0] ?? 'opus'
      const perRequest =
        s.contextTokens !== undefined && rate !== undefined ? s.contextTokens * 0.1 * priceOf(mainFamily) * rate : undefined

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text color={ORANGE} bold>
                {money(s.costUsd)}
              </Text>
              <Text color={GRAY}>{isPlan ? ' ≈ API value' : ' spent this session'}</Text>
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
                    <Text color={GRAY}> {money(rate === undefined ? undefined : top.weight * rate)}</Text>
                  </Text>
                )}
                {recent.length === 0 && <Text color={GRAY}>No prompts yet.</Text>}
                {recent.map((p, i) => (
                  <Box justifyContent="space-between" gap={1}>
                    <Text wrap="truncate-end">
                      <Text color={i === 0 && lv.isRunning ? GREEN : GRAY}>● </Text>
                      {p.text ? short(p.text, 60) : `prompt #${p.n}`}
                    </Text>
                    <Text color={GRAY}>
                      {p.requests}× {money(rate === undefined ? undefined : p.weight * rate)}
                    </Text>
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
                  <Text color={GRAY}> · </Text>
                  <Text color={BLUE}>■ </Text>Subagents {Math.round((l.sub / total) * 100)}% {money(rate === undefined ? undefined : l.sub * rate)}
                </Text>
                {stacked(models.map(([, w], i) => ({ share: w / total, color: SERIES[i % SERIES.length] ?? GRAY })))}
                <Text wrap="truncate-end">
                  {models.map(([name, w], i) => (
                    <Text>
                      {i > 0 && <Text color={GRAY}> · </Text>}
                      <Text color={SERIES[i % SERIES.length] ?? GRAY}>■ </Text>
                      {name} {Math.round((w / total) * 100)}% {money(rate === undefined ? undefined : w * rate)}
                    </Text>
                  ))}
                </Text>
              </Box>
            )}
            {isOpen('breakdown') && total === 0 && <Text color={GRAY}>Nothing measured yet.</Text>}
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
                    <Text color={GRAY}>
                      {fmt(k.tokens)} {money(rate === undefined ? undefined : k.weight * rate)}
                    </Text>
                  </Box>
                ))}
                {l.contexts.length > 1 && (
                  <Box gap={1} alignItems="center">
                    <Text color={GRAY}>last {l.contexts.length}</Text>
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
          {isPlan && <Text color={GRAY}>Your plan isn't billed per token; these are API-price estimates.</Text>}
        </Box>
      )
    }

    const liveTab = () => {
      const elapsed = lv.startedAt ? (lv.isRunning ? now : lv.endedAt ?? now) - lv.startedAt : 0
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text color={lv.isRunning ? GREEN : GRAY} bold>
                {lv.isRunning ? '● Working' : '○ Idle'}
              </Text>
              {lv.startedAt > 0 && (
                <Text color={GRAY}>
                  {' '}
                  · {lv.isRunning ? 'running' : 'last turn took'} {Math.round(elapsed / 1000)}s
                </Text>
              )}
            </Text>
            {lv.promptText ? <Text wrap="truncate-end">{lv.promptText}</Text> : <Text color={GRAY}>No turn yet.</Text>}
          </Box>

          {limits}

          <Box flexDirection="column">
            <Text color={ORANGE} bold>
              This turn
            </Text>
            <Text>
              {lv.requests} requests · {lv.toolCount} tool calls ·{' '}
              <Text color={ORANGE}>≈{money(rate === undefined ? undefined : lv.weight * rate)}</Text>
            </Text>
            <Text color={GRAY}>
              in {fmt(lv.tokens.input)} · cache read {fmt(lv.tokens.cacheRead)} · cache write {fmt(lv.tokens.cacheWrite)} · out{' '}
              {fmt(lv.tokens.output)}
            </Text>
          </Box>

          <Box flexDirection="column">
            <Text color={BLUE} bold>
              Recent tools
            </Text>
            {lv.tools.length === 0 && <Text color={GRAY}>None this turn.</Text>}
            {[...lv.tools].reverse().map((tool, i) => (
              <Text color={i === 0 && lv.isRunning ? GREEN : GRAY}>
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
            <Text color={GRAY}>{label} </Text>
            <Text color={tone} bold>
              {money(t.current)}
            </Text>
            <Text color={GRAY}> · </Text>
            {t.pct === undefined ? (
              <Text color={GRAY}>no spend last {period} to compare</Text>
            ) : t.pct > 0 ? (
              <Text color={tone} bold>
                ▲ {t.pct}% vs last {period}
              </Text>
            ) : t.pct < 0 ? (
              <Text color={tone} bold>
                ▼ {-t.pct}% vs last {period}
              </Text>
            ) : (
              <Text color={GRAY}>= same as last {period}</Text>
            )}
          </Text>
        )
      }
      const trends = (
        <Box flexDirection="column">
          {trendLine('This week', 'week', periodTrend(rows, weekStart, lastWeekStart, now), BLUE)}
          {trendLine('This month', 'month', periodTrend(rows, monthStart, lastMonthStart, now), GREEN)}
          <Text color={GRAY}>Compared with the same point last week and last month.</Text>
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
                      <Text color={GRAY}>
                        {Math.round((c / sum) * 100)}% <Text color={ORANGE}>{money(c)}</Text>
                      </Text>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Text color={GRAY}>No spend this week yet.</Text>
              ))}
          </Box>
        )
      }
      const budgetLine =
        limit > 0 ? (
          meter('day', Math.round((today / limit) * 100), `${money(today)} / ${money(limit)}`)
        ) : (
          <Text color={GRAY}>No daily budget · set one with /usage-budget 10</Text>
        )
      const stat = (label: string, value: string, color: string) => (
        <Text>
          <Text color={GRAY}>{label} </Text>
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
              height={heat.h}
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
            <Text color={GRAY}>{dayLabel(firstDay, startOfToday)} → Today · Less</Text>
            {Svg ? (
              <Svg source={legend.source} width={legend.w} height={legend.h} alt="From no spend to the most" />
            ) : (
              <Text color={ORANGE}>{HEAT_TEXT.join('')}</Text>
            )}
            <Text color={GRAY}>More</Text>
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
              <Text color={GRAY}>Today </Text>
              <Text color={ORANGE} bold>
                {money(today)}
              </Text>
              <Text color={GRAY}> · 7 days </Text>
              <Text color={BLUE} bold>
                {money(total(now - 7 * DAY))}
              </Text>
              <Text color={GRAY}> · 30 days </Text>
              <Text color={GREEN} bold>
                {money(total(now - KEEP_DAYS * DAY))}
              </Text>
            </Text>
            {trends}
            <Box gap={2} alignItems="center">
              <Text color={GRAY}>
                {recent.length} session{recent.length === 1 ? '' : 's'} in the last {KEEP_DAYS} days
              </Text>
              <Button
                key="export"
                plain
                label="⤓ Export CSV"
                onPress={async () => {
                  const { path } = await exportHistory($).catch(() => ({ path: '' }))
                  $.ui.toast(path ? `Saved ${path}` : 'Export failed', { timeoutMs: 8000 })
                }}
              />
            </Box>
            {budgetLine}
          </Box>

          {stats}

          {split('week-models', 'This week by model', '▥', spendBy(thisWeek, byModel))}
          {split('week-projects', 'This week by project', '▤', spendBy(thisWeek, byProject))}

          {recent.length === 0 && <Text color={GRAY}>No sessions recorded yet.</Text>}
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
                    <Text color={r.id === id ? GREEN : GRAY}>{r.id === id ? '● ' : '· '}</Text>
                    <Text color={GRAY}>{clockTime(r.startedAt)} </Text>
                    {r.title || 'Untitled session'}
                  </Text>
                  <Text color={GRAY}>
                    {r.prompts}p <Text color={ORANGE}>{money(r.cost)}</Text>
                  </Text>
                </Box>
              ))}
            </Box>
          ))}
          {isPlan && <Text color={GRAY}>Costs are API-price estimates; your plan isn't billed per token.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" minHeight={bodyRows} justifyContent="space-between">
        <Box flexDirection="column" gap={1}>
          {header}
          {v.tab === 'session' ? sessionTab() : v.tab === 'live' ? liveTab() : historyTab()}
        </Box>
        <Text color={GRAY}>usage-mod v{VERSION}</Text>
      </Box>
    )
  })
}
