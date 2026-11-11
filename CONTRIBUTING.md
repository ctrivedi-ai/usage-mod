# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Open an issue for a bug or an idea. For a bug, say what you did, what you expected, what happened instead, and your usage-mod version. A screenshot of the pane helps. Security problems go through [SECURITY.md](SECURITY.md), not an issue.

## Pull requests

1. Fork the repo and make a branch from `main`.
2. Keep each PR to one change. Open an issue first for anything large so we can agree on the approach.
3. Run the tests in `tests/` and check the pane in both dark and light themes.
4. Add a line to `CHANGELOG.md` under a new version heading that says what changed for the user.
5. Open the PR against `main` and fill in the template.

PRs are squash-merged, so the PR title becomes the commit message. The `gitleaks` secret scan must pass. For a first-time contributor, workflows wait for the maintainer to approve them before they run.

## Before you commit

Never commit secrets, personal email addresses or machine-specific paths. Install [pre-commit](https://pre-commit.com) and run `pre-commit install` to scan for secrets locally before each commit.

By contributing, you agree your work is released under the [MIT License](LICENSE).
