<h1 align="center">
  <img src=".claude-plugin/icon.png" width="72" alt=""><br>
  usage-mod
</h1>

<p align="center"><b>See what this Claude Code session is costing you, while it runs.</b></p>

<p align="center">
  <a href="https://github.com/ctrivedi-ai/usage-mod/actions/workflows/secret-scan.yml"><img src="https://github.com/ctrivedi-ai/usage-mod/actions/workflows/secret-scan.yml/badge.svg?branch=main" alt="Secret scan"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-788c5d" alt="MIT license"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-latest-d97757" alt="Changelog"></a>
</p>

```
/plugin install usage-mod --marketplace ctrivedi-ai/usage-mod
```

<p align="center">
  <img src="docs/hero.svg" width="820" alt="The Usage pane beside a Claude Code chat. While Claude works, the session cost rises, the context bar grows, and the cost of the running prompt, the breakdown by model and the status line update with it.">
  <br>
  <sub>An illustration of the Session tab, with sample data.</sub>
</p>

If usage-mod shows you something you didn't know about your sessions, star the repo so other Claude Code users can find it.

## The problem

Claude Code tells you a session's total cost if you ask. It doesn't tell you which prompt was the expensive one, how much went to subagents, or how close you are to the 5-hour limit before you start a long run.

usage-mod is a Claude Code mod that keeps a **Usage** pane beside the chat and a one-line summary under the prompt. It runs inside the session, so there is no separate app to open, no account and nothing to configure.

## What you get

### Session

The session's cost, then bars for context, the 5-hour limit and the 7-day limit, each with its reset time. Below them are three sections you can collapse:

- **Prompts**: each prompt's request count and cost, plus the most expensive one.
- **Breakdown**: main thread against subagents, and by model.
- **Tokens**: new input, cache read, cache write and output, with a sparkline of the last 20 requests' context size.

It warns you when every request is re-sending a large context.

**Limit forecast.** When you are on course to reach the 5-hour or 7-day limit before it resets, a line under the bars says how long you have:

```
⚑ 5h limit in ~42m at this pace (resets in 1h50m)
```

The same appears in the status line (`5h 64% ⚑42m`), and a toast warns you once when the limit is close. The pace is taken from the last half hour of the session, or from the window so far when the session is new. It is an estimate.

### Live

The turn in progress: whether Claude is working, its prompt, requests, tool calls, tokens and cost so far, and the most recent tools.

### History

The last 30 days:

- Totals for today, 7 days and 30 days.
- This week and this month against the previous one (▲ up, ▼ down, as a %, coloured by the trend).
- This week's spend by model and by project.
- A heatmap of daily spend, your streak and your busiest day.
- Your daily budget, and every session grouped by day.
- **Export CSV** saves it all to a file.

### Guard

The mod watches each turn's tool calls and tells you when Claude is going round in circles: a toast when the same call is made 5 times in a row, or when the same call fails 3 times. Nothing is stopped unless you ask for it.

`/usage-guard stop` makes it act. It refuses a call made more than 8 times in a row, a call that has failed 5 times in the turn, and every tool call once your daily budget is reached. Claude is told why each call was refused, so it can try something else or tell you. The Live tab shows how many calls were stopped.

### Status line

A summary sits under the prompt:

```
ctx 15% · $4.26 · 5h 12% · 7d 3%
```

`/usage-status full` leads with the limits and when they reset, then today's spend against your budget:

```
5h 12% ↺3h37m · 7d 3% ↺4d8h · today $3.12/$10.00 · $4.26 · ctx 15%
```

## Commands

| Command | What it does |
| --- | --- |
| `/usage-pane` | Reopens the pane. Switch tabs with the buttons or the hotkeys 1, 2 and 3 while the pane has focus. |
| `/usage-budget 10` | Sets a daily budget in dollars. A toast appears at 80% and at 100%. `off` turns it off; no argument shows where you stand. |
| `/usage-status full` | Shows the longer status line. `compact` goes back to the short one, `off` hides it, and no argument flips between compact and full. Your choice is kept. |
| `/usage-guard stop` | Refuses a tool call that is looping or keeps failing, and every tool call once the daily budget is reached. `warn` (the default) only shows a toast, `off` turns the guard off, and no argument shows the setting. Your choice is kept. |
| `/usage-export` | Saves the history as `usage-history.csv` in the working directory, replacing the last export there. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-mod --marketplace ctrivedi-ai/usage-mod
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install usage-mod --marketplace ctrivedi-ai/usage-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ctrivedi-ai/usage-mod`, then Add plugin.

## Questions

**I pay a flat fee for a subscription. Why does it show dollars?**
The dollars are what the session would cost at API prices. On a subscription they are an estimate of value, not what you are billed. The 5-hour and 7-day bars are the figures that matter for your plan.

**I keep hitting my 5-hour or weekly limit. Can I see it coming?**
Yes. Both limits are bars in the pane with the time until they reset, and both are in the status line. When your pace would take you to a limit before it resets, the pane and the status line say how long you have left, and a toast warns you when it is close.

**Which prompt cost the most?**
Open Prompts on the Session tab. Every prompt is listed with its request count and cost, and the most expensive is called out.

**Do my subagents cost more than the main thread?**
Breakdown on the Session tab splits the session's cost between the main thread and subagents, and by model.

**Why did a short question cost so much?**
Usually because the context is large and every request re-sends it. The pane warns you when that is happening, and the Tokens sparkline shows the context growing.

**How accurate are the numbers?**
The session total is Claude Code's own figure. The shares of it (per prompt, per kind of token, per model) are estimates from each request's token counts and Anthropic's price ratios, and they add up to that total.

**Does it show sessions from before I installed it?**
No. History covers sessions where the mod was running, and prompts are itemised from the moment it loads.

## Private by design

usage-mod makes no network calls. It reads what Claude Code gives a mod about the current session and keeps its history in the mod's own local store. 

**What it writes.** One file, and only when you ask: `usage-history.csv` in the session's working directory, from `/usage-export` or the Export CSV button. It is a plain table of your sessions. The mod never writes a build, start-up, settings or instructions file.

**What it hooks.** The mod listens to the session's events to count cost, tokens and tool calls, and it does not change them. The one exception is the guard: with `/usage-guard stop`, its `tool.call` hook refuses a tool call that is looping, keeps failing or comes after the daily budget is reached. With the default `warn`, and with `off`, every tool call runs as it would without the mod.

**What it adds.** Five slash commands, listed under [Commands](#commands). It adds no tools and no agents.

## Contributing

Bug reports and ideas are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md). Security reports go through [SECURITY.md](SECURITY.md).

Every push and pull request runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history (`.github/workflows/secret-scan.yml`). To scan before you commit, install [pre-commit](https://pre-commit.com) and run `pre-commit install`.

## License

MIT. Not affiliated with or endorsed by Anthropic.
