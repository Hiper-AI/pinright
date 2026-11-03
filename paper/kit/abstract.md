# pinright: abstract

*Juan Pablo Mandelbaum, Hiper AI. Technical report, version 1.0.0, 2026-11-03.*

Coding agents pick dependency versions from what their model saw in training, and those versions
often carry advisories published since. We ran Claude Code with three models (Sonnet 5.5, Haiku 5.5,
Opus 5.5) on 12 tasks we wrote, two runs each, and audited every project with `npm audit` or
`pip-audit`. With file tools only and nothing attached, 40% to 42% of the direct dependencies each
model pinned had a known advisory, and projects averaged 30 to 32 whole-tree alerts. pinright is an
MIT-licensed MCP server, CLI, pre-install hook and GitHub Action that gives the agent a verdict on
each dependency and docs from the package at the version it installs. With its security layer off,
pinright already cut alerts to 84, 63 and 6 over 24 projects per model. The full server brought every
model to 6 alerts, all in nuxt dependencies with no fixed release, and no vulnerable direct pins,
with 21% to 33% fewer tokens per run than that ablation. Agents given a shell looked versions up
themselves, and every arm ended at the same 6 alerts: there pinright made no measurable difference.
With pinright's docs, all three models wrote the current API of eight recently changed libraries in
16 of 16 runs, against 9 to 14 without. The results come from one vendor's models, two days of
advisory data and tasks we wrote.

(226 words. The report's abstract is the long form.)
