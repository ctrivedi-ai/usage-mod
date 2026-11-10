# usage-mod

A Claude Code mod that keeps a **Usage** pane beside the chat, with a small meter badge in the header that moves while Claude works. Switch tabs with the buttons or the hotkeys 1, 2 and 3 while the pane has focus.

- **Session**: the session's cost, context and rate-limit bars with reset times, then three sections you can collapse: Prompts (each prompt's request count and cost, plus the most expensive one), Breakdown (main thread vs subagents, and by model) and Tokens (new input, cache read, cache write and output, with a sparkline of the last 20 requests' context size). It warns when every request is re-sending a large context.
- **Live**: the turn in progress: whether Claude is working, its prompt, requests, tool calls, tokens and cost so far, and the most recent tools.
- **History**: the last 30 days: totals for today, 7 days and 30 days, this week and this month with the change from last week and last month (▲ up, ▼ down, as a %, coloured by the trend), this week's spend by model and by project, a heatmap of daily spend, your daily budget, and each session grouped by day. **Export CSV** saves it all to a file.

A status line under the prompt sums it up (`ctx 15% · $4.26 · 5h 12% · 7d 3%`), and `/usage-pane` reopens the pane.

- `/usage-budget 10` sets a daily budget in dollars; a toast appears at 80% and at 100%. `/usage-budget off` turns it off, and `/usage-budget` alone shows where you stand.
- `/usage-export` saves the history as `usage-history-<date>.csv` in the working directory.
- `/usage-status full` adds context tokens, today's spend (against your budget) and reset times: `ctx 15% 30k/200k · $4.26 · today $3.12/$10.00 · 5h 12% ↺3h37m`. `/usage-status compact` goes back to the short line, `off` hides it, and `/usage-status` alone flips between compact and full. Your choice is kept.

The total cost is the engine's own figure. Shares of it (per prompt, per kind of token, per model) are estimates from each request's token counts and Anthropic's price ratios. On a subscription plan these are API-price estimates, not what you are billed.

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

Not affiliated with or endorsed by Anthropic.

## Secret scanning

Every push and pull request runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history (`.github/workflows/secret-scan.yml`). To scan before you commit, install [pre-commit](https://pre-commit.com) and run `pre-commit install`.
