# pinright: abstract

Coding agents pick dependency versions from what their model saw in training, and those versions
often carry advisories published since. We ran Claude Code with three models (Sonnet 5.5, Haiku 5.5,
Opus 5.5) on 12 tasks we wrote, two runs each, and audited every project with `npm audit` or
`pip-audit`. Without tools, 40% to 42% of the direct dependencies each model pinned had a known
advisory, and projects averaged 30 to 33 whole-tree alerts. pinright is an MIT-licensed MCP server,
CLI, pre-install hook and GitHub Action that gives the agent a verdict on each dependency and docs
from the package at the version it installs. An ablation with its security layer off, which documents
the latest release, cut alerts to 48, 21 and 6 over 24 projects per model: steering the agent to
current versions removes most of the exposure. The full server brought every model to 6 alerts, all
in nuxt dependencies with no fixed release, and no vulnerable direct pins. The hook alone left 10 to
14. With pinright's docs, all three models wrote the current API of eight recently changed libraries
in 16 of 16 runs, against 10 to 13 without. The results come from one vendor's models, one day of
advisory data and tasks we wrote.

(198 words. The report's abstract is the long form.)
