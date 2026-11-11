# Changelog

## 0.9.12

- README rewritten: a one-line pitch and the install command at the top, an animated illustration of the pane (`docs/hero.svg`), a commands table, common questions and a privacy note. The mod itself is unchanged.

## 0.9.11

- Model breakdowns group saved entries by family when drawn, so a model recorded under its full id before 0.9.9 (such as `claude-fable-5-2`) now shows as "fable". This applies to Session → Breakdown and History → This week by model. Saved data is unchanged.

## 0.9.10

- Cache reads are weighed at each model's real rate: 0.025× input on Fable and Mythos 5.1/5.2, 0.05× on Opus 5.5 and Sonnet 5.5, and 0.1× elsewhere. Cache reads used to be weighed at 0.1× for every model, which made them look like too large a share of the cost in Tokens, Prompts and the per-model split.
- Older models get their own prices. 0.9.9 recognised only the model family, so every Opus was priced as Opus 5.5. The version is now read from the model id: Fable 5/5.1 $10, Opus 5 and 4.x $5, Sonnet 4.x $3, Haiku 4.5 $1.
- The "≈$x each" estimate on the context warning uses the model's cache-read rate.
- The session total is unchanged: it always comes straight from Claude Code.

## 0.9.9

- Fable and Mythos show as "fable" and "mythos" in the model breakdowns, instead of their full model ids.
- The per-model, per-prompt and per-token-kind estimates use current prices: Fable/Mythos 8, Opus 4, Sonnet 2 and Haiku 0.1 per million input tokens. 4.x models keep their own prices (Opus 5, Sonnet 3, Haiku 1). The session total was always exact; this only changes how it's split.
- A turn started by a subagent's report or a background event shows in Prompts as "↳ subagent report" or "↳ automatic event", not as raw tagged text. Its cost still counts.

## 0.9.8

- The full status line now leads with the 5-hour and 7-day limits and their reset times, then today's spend, the session cost and context: `5h 25% ↺3h10m · 7d 10% ↺4d8h · today $7.29 · $4.43 · ctx 18%`. The desktop footer shows only about 40 characters, so the reset times now stay visible there. The context token count is gone; the percentage and the pane still show it.

## 0.9.7

- The context, 5-hour and 7-day bars are all the same width, so their ends line up.
- Empty days in the activity heatmap are darker, so they show on a light background.

## 0.9.6

- New `/usage-status` command for the status line under the prompt:
  - `compact`: the short line, and still the default: `ctx 8% · $0.27 · 5h 16% · 7d 8%`.
  - `full`: adds context tokens, today's spend (shown against your daily budget if you set one) and when each limit resets: `ctx 8% 81k/1.0M · $0.27 · today $3.12/$10.00 · 5h 16% ↺3h37m · 7d 8% ↺4d8h`.
  - `off`: hides the line.
  - With no argument, it switches between compact and full.
- Your choice carries over to new sessions.
- The status line redraws after each request is added to the history, and right away when the budget changes.

## 0.9.5

- Light theme: grey text follows the app's theme instead of a fixed grey that was faint on white.
- The amber used for 60–85% bars, small rises and the context warning is darker, so it reads on light backgrounds.
- The heatmap's weekday labels use a mid grey that works on both themes.

## 0.9.4

- Amounts on the right of each row (session cost, prompt count, model and project shares) no longer wrap onto a second line. A long title is cut off with "…" instead.

## 0.9.3

- The context, 5-hour and 7-day bars are sized around their own labels, so the percentage and reset time stay on the same line in the desktop pane.

## 0.9.2

- **Export CSV** is drawn as a primary button with its ⇩ icon on desktop.

## 0.9.1

- Restyled the Export CSV button with a new icon.

## 0.9.0

- First public release:
  - Session, Live and History tabs.
  - A status-line summary.
  - A daily budget with alerts.
  - CSV export.
  - Install from the `ctrivedi-ai/usage-mod` marketplace.
