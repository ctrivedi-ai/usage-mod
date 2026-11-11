import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'usage-mod',
  component: 'Pane',
  requestId: 'usage',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Everything beneath the plugin: each hook stands for the engine.
const engine = (on: On, onStatus: (text: string | undefined) => void = () => {}, stored: Record<string, unknown> = {}) => {
  // What the plugin showed and wrote, for the tests to read.
  const seen = { toasts: [] as string[], files: {} as Record<string, string> }
  mock.store(on, stored)
  on('ui.toast', (_, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('session.cwd', () => ({ value: 'C:\\work\\proj' }))
  on('fs.write', (_, e) => ((seen.files[e.path] = e.text), { value: undefined }))
  on('command.run', () => ({}))
  on('command.register', () => ({ value: { command: 'usage-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => (onStatus(e.text), { value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-01-01T00:00:00Z') }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
    turnId: e.turnId,
    index: e.index,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn',
    usage: {
      model: e.model,
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 4_000,
      },
    } as const
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return seen
}

const oneTurn = async ($: Parameters<Parameters<typeof test>[1]>[0], contextTokens = 45_000) => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Make the pane colourful', turnId: 't1' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step);
  await step.result
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.session.measure({
    context: { tokens: contextTokens, window: 200_000, percent: Math.round((contextTokens / 200_000) * 100) },
    cost: { usd: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-01-01T00:26:00Z' }],
    changed: ['context', 'cost', 'rateLimits'],
  })
}

test('the session tab shows cost, limits, prompts, breakdown and tokens, on every surface', async ($, on) => {
  engine(on)
  await oneTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /≈ API value/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40% ↺26m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Most expensive: prompt #1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Make the pane colourful/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1× \$1\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Main 100% \$1\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /opus 100% \$1\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /isn't billed per token/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tokens of context per request/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /usage-mod v0.9.12/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the tabs switch to Live and History, and a section collapses', async ($, on) => {
  engine(on)
  await oneTurn($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'sec-prompts' })
    expect(await ui.find({ type: 'Text', text: /Most expensive/ })).toBeUndefined()
    await ui.press({ key: 'sec-prompts' })
    expect(await ui.find({ type: 'Text', text: /Most expensive/ })).toBeDefined()

    await ui.press({ key: 'tab-live' })
    expect(await ui.find({ type: 'Text', text: /○ Idle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 requests · 1 tool calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeDefined()

    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: /1 session in the last 30 days/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Today$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Make the pane colourful/ })).toBeDefined()

    await ui.press({ key: 'tab-session' })
    await ui.unmount()
  }
})

test('history keeps the last 30 days and drops older sessions', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-01-01T00:00:00Z')
  engine(on, undefined, {
    history: [
      { id: 'recent', startedAt: now - 10 * day, updatedAt: now - 10 * day, cost: 2, prompts: 3, title: 'Ten days ago' },
      { id: 'old', startedAt: now - 40 * day, updatedAt: now - 40 * day, cost: 5, prompts: 4, title: 'Forty days ago' },
    ],
  })
  await oneTurn($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: /2 sessions in the last 30 days/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ten days ago/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Forty days ago/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\$3\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Activity, last 30 days/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^2\/30$/ })).toBeDefined()
  await ui.unmount()

  // The terminal draws the heatmap in text, one line per weekday.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'tab-history' })
  expect(await term.find({ type: 'Text', text: /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) .*█/ })).toBeDefined()
  await term.unmount()
})

test('this week and this month show their spend and the change from last time', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-01-01T00:00:00Z')
  engine(on, undefined, {
    // A week back and an hour earlier: inside last week's matching stretch, and in December.
    history: [{ id: 'last-week', startedAt: now - 7 * day - 3_600_000, updatedAt: now - 7 * day - 3_600_000, cost: 0.5, prompts: 1, title: 'Last week' }],
  })
  await oneTurn($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: /^▲ 100% vs last week$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^no spend last month to compare$/ })).toBeDefined()
  await ui.unmount()
})

test('spending less than last week shows a fall', async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-01-01T00:00:00Z')
  engine(on, undefined, {
    history: [{ id: 'last-week', startedAt: now - 7 * day - 3_600_000, updatedAt: now - 7 * day - 3_600_000, cost: 4, prompts: 1, title: 'Last week' }],
  })
  await oneTurn($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: /^▼ 75% vs last week$/ })).toBeDefined()
  await ui.unmount()
})

test('this week splits by model and by project, with older rows under their own label', async ($, on) => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  engine(on, undefined, {
    // Earlier this week, from before rows kept a project or models.
    history: [{ id: 'older', startedAt: now - 3_600_000, updatedAt: now - 3_600_000, cost: 3, prompts: 2, title: 'Older row' }],
  })
  await oneTurn($)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: /■ opus$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /■ not tracked$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /■ proj$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /■ not recorded$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^75% \$3\.00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^25% \$1\.00$/ })).toBeDefined()

    await ui.press({ key: 'sec-week-projects' })
    expect(await ui.find({ type: 'Text', text: /■ proj$/ })).toBeUndefined()
    await ui.press({ key: 'sec-week-projects' })
    await ui.unmount()
  }
})

test('a daily budget toasts once at 80% and once at 100%, and shows in History', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const set = await $.command.run({ command: 'usage-budget', args: '1.20' })
  expect(set.text).toMatch(/Daily budget set to \$1\.20/)

  // $1 of $1.20 is 83%: one 80% toast, and the same again stays quiet.
  await oneTurn($)
  await oneTurn($)
  expect(seen.toasts).toEqual(["80% of today's budget used: $1.00 of $1.20"])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: /\$1\.00 \/ \$1\.20/ })).toBeDefined()
  await ui.unmount()

  // Lowering it past what's spent raises the 100% toast straight away.
  await $.command.run({ command: 'usage-budget', args: '$0.50' })
  expect(seen.toasts.at(-1)).toBe('⚑ Daily budget reached: $1.00 of $0.50 today')

  const off = await $.command.run({ command: 'usage-budget', args: 'off' })
  expect(off.text).toBe('Daily budget turned off.')
})

test('export writes the history as CSV, from the command and the button', async ($, on) => {
  const seen = engine(on)
  await oneTurn($)

  const out = await $.command.run({ command: 'usage-export' })
  expect(out.text).toMatch(/^Saved 1 session to C:\\work\\proj\\usage-history-\d{4}-\d{2}-\d{2}\.csv$/)
  const [path, csv] = Object.entries(seen.files)[0] ?? []
  expect(csv?.split('\n')[0]).toBe('started,last_active,cost_usd,prompts,title,session_id')
  expect(csv).toContain(',1.0000,1,Make the pane colourful,session-1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-history' })
  await ui.press({ key: 'export' })
  expect(seen.toasts.at(-1)).toBe(`Saved ${path}`)
  await ui.unmount()
})

test('a large context raises the per-request warning', async ($, on) => {
  engine(on)
  await oneTurn($, 150_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /~150k tokens of context per request, ≈\$/ })).toBeDefined()
  await ui.unmount()
})

test('the status line sums up context, cost and rate limits', async ($, on) => {
  const lines: (string | undefined)[] = []
  engine(on, text => lines.push(text))
  await oneTurn($)

  expect(lines.at(-1)).toBe('ctx 23% · $1.00 · 5h 40%')
})

test('/usage-status switches the status line between compact, full and off, and remembers it', async ($, on) => {
  const lines: (string | undefined)[] = []
  engine(on, text => lines.push(text))
  await oneTurn($)

  const full = await $.command.run({ command: 'usage-status', args: 'full' })
  expect(full.text).toBe('Status line set to full.')
  expect(lines.at(-1)).toBe('5h 40% ↺26m · today $1.00 · $1.00 · ctx 23%')

  await $.command.run({ command: 'usage-budget', args: '10' })
  expect(lines.at(-1)).toMatch(/today \$1\.00\/\$10\.00/)

  const off = await $.command.run({ command: 'usage-status', args: 'off' })
  expect(off.text).toMatch(/^Status line turned off/)
  expect(lines.at(-1)).toBeUndefined()

  // No argument flips to full; compact goes back to the short line.
  await $.command.run({ command: 'usage-status', args: '' })
  expect(lines.at(-1)).toMatch(/^5h 40% ↺26m · today /)
  await $.command.run({ command: 'usage-status', args: 'compact' })
  expect(lines.at(-1)).toBe('ctx 23% · $1.00 · 5h 40%')

  const bad = await $.command.run({ command: 'usage-status', args: 'huge' })
  expect(bad.text).toMatch(/^Unknown style "huge"/)
})

test('a stored status style carries over to a new session', async ($, on) => {
  const lines: (string | undefined)[] = []
  engine(on, text => lines.push(text), { statusStyle: 'full' })
  await oneTurn($)

  expect(lines.at(-1)).toBe('5h 40% ↺26m · today $1.00 · $1.00 · ctx 23%')
})

test('Fable is named as a model, and a subagent report is not shown as a typed prompt', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '<agent-message from="abc123">[Subagent hand-back] done</agent-message>', turnId: 't1' })
  for (const model of ['claude-opus-5-5', 'claude-fable-5-2']) {
    const step = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })
    for await (const _ of step);
    await step.result
  }
  await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.session.measure({
    context: { tokens: 45_000, window: 200_000, percent: 23 },
    cost: { usd: 3 },
    rateLimits: [],
    changed: ['context', 'cost'],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The same tokens per request (1k in, 2k out, 40k cache read, 4k cache write):
  // Opus 5.5 at $4 with reads at 0.05x weighs 72k; Fable 5.2 at $8 with reads at
  // 0.025x weighs 136k. Of $3, that's $1.04 (35%) and $1.96 (65%).
  expect(await ui.find({ type: 'Text', text: /opus 35% \$1\.04/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fable 65% \$1\.96/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-fable/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↳ subagent report/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent-message/ })).toBeUndefined()
  await ui.unmount()
})

test('a model saved under its full id before v0.9.9 shows under its family name', async ($, on) => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  engine(on, undefined, {
    history: [
      { id: 'earlier', startedAt: now - 60_000, updatedAt: now - 60_000, cost: 3, prompts: 2, title: 'Earlier', models: { opus: 2, 'claude-fable-5-2': 1 } },
    ],
  })
  await oneTurn($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-history' })
  // This week: opus $2 plus this session's $1, and fable $1.
  expect(await ui.find({ type: 'Text', text: /fable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-fable/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /25% \$1\.00/ })).toBeDefined()
  await ui.unmount()
})
