export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** One reading of a rate limit: when (ms) and how full (%). */
export type PaceSample = { t: number; pct: number }

export type Snapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd?: number
  rateLimits: RateWindow[]
}

// Token counts by kind; `Ledger.weights` holds the same kinds priced in
// input-token units, so a share of the session's real cost can be read off.
export type Bucket = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PromptRec = { n: number; text: string; requests: number; weight: number }

export type Ledger = {
  promptCount: number
  prompts: PromptRec[]
  requests: number
  tokens: Bucket
  weights: Bucket
  main: number
  sub: number
  byModel: Record<string, number>
  contexts: number[]
  baseCost: number
}

export type Live = {
  isRunning: boolean
  promptText: string
  startedAt: number
  endedAt?: number
  requests: number
  toolCount: number
  tools: string[]
  tokens: Bucket
  weight: number
}

export type Tab = 'session' | 'live' | 'history'
/** How much the status line under the prompt says. */
export type StatusStyle = 'compact' | 'full' | 'off'

/** The guard: warn about a looping or failing tool call, stop it as well, or neither. */
export type GuardMode = 'warn' | 'stop' | 'off'

/**
 * What the guard has seen this turn: the last call's signature and how many
 * times running it has been made, failures per signature, and calls refused.
 */
export type Watch = { last: string; repeats: number; fails: Record<string, number>; blocked: number }

export type View ={ tab: Tab; closed: string[] }

// `project` is the session's working directory and `models` its cost in dollars per
// model family; rows written before v0.8.0 have neither.
export type HistoryRow = {
  id: string
  startedAt: number
  updatedAt: number
  cost: number
  prompts: number
  title: string
  project?: string
  models?: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'usage-mod': {
      snapshot: Snapshot
      ledger: Ledger
      live: Live
      view: View
      history: HistoryRow[]
      sessionId: string
      budget: number
      statusStyle: StatusStyle
      pace: Record<string, PaceSample[]>
      guard: GuardMode
      watch: Watch
    }
  }
}
