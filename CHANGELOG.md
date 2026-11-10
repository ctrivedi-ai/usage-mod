# Changelog

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
