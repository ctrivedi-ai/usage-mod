# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately instead: on this repository's **Security** tab, choose **Report a vulnerability**. Only the maintainer can see the report.

Include what you found, how to reproduce it, and which version of usage-mod you're running (shown in `CHANGELOG.md` and the plugin manifest). You should get a reply within a week.

## Supported versions

Only the latest release gets fixes. Update with `/plugin` (or `claude plugin update usage-mod`) before reporting.

## Scope

usage-mod runs inside Claude Code on your own machine. It reads Claude Code's usage data and writes its history and settings locally. It sends nothing over the network. Reports about how it reads, stores or exports that data are in scope. Problems in Claude Code itself should go to Anthropic.
