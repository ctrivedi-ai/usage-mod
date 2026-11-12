# Privacy

usage-mod runs inside Claude Code on your own machine. It makes no network calls, so nothing it reads or stores is sent to its author or to anyone else. There is no server, no account and no analytics.

## What it reads

What Claude Code gives a mod about the current session: the session's cost, context size and rate limits, each request's token counts and model, the names of the tools Claude calls and their arguments, and the text of your prompts.

## What it keeps

In the mod's own local store, on your machine:

- **Session history.** One row per session: its id, start and last-active times, cost, number of prompts, a title (the first 60 characters of the session's first prompt), the session's working folder, and its cost per model. Rows older than 62 days are dropped, and at most 500 are kept.
- **Your settings.** The daily budget, the status-line style and the guard mode, plus markers for which budget and limit warnings have already been shown.

The title and the working folder can contain personal information if your prompt or folder path does.

Everything else, including the full text of prompts and tool arguments, is held only while the session runs and is not saved.

## What it writes

One file, and only when you ask: `usage-history.csv` in the session's working directory, from `/usage-export` or the Export CSV button. It holds the session history above. It stays until you delete it.

## Removing your data

Uninstalling the mod stops all of the above. The history and settings are in a file named `usage-mod_…json` under `.claude/plugins/store` in your home folder; delete that file to erase them. Exported CSV files are ordinary files you can delete.

## Questions

Open an issue at <https://github.com/ctrivedi-ai/usage-mod/issues>.
