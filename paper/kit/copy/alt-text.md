# Alt text

One entry per figure and visual. The dark variants use the same text.

## Figures

**fig-a-alerts-per-project.** Bar chart of mean whole-tree alerts per project for three models and six
arms, with 95% intervals. Without tools: 31.9 (Sonnet), 29.8 (Haiku), 30.5 (Opus). pinright with its
security layer off: 3.5, 2.6, 0.3. pinright MCP server and MCP plus hook: 0.3 for every model. Hook
only: 0.6 for every model. Packages installed without a version: 0.3. A second panel repeats the data
without the no-tools arm on a scale of 0 to 12.

**fig-b-direct-deps-with-advisories.** Bar chart of the share of pinned direct dependencies with a
known advisory. Without tools: 40% for Sonnet, 40% for Haiku, 42% for Opus. pinright with its
security layer off: 2%, 2%, 0%. Every pinright arm and the unpinned reference: 0%.

**fig-c-docs-current-api.** Bar chart of docs-benchmark runs that wrote the current API of eight
recently changed libraries. Without docs: 13 of 16 (Sonnet), 9 of 16 (Haiku), 14 of 16 (Opus).
pinright with its security layer off: 16, 15 and 16 of 16. pinright: 16 of 16 for every model.

**fig-d-retrieval-probes.** Bar chart of probe questions answered with the current API, before
tuning and on the release candidate. Original set: 16 to 24 of 25. Held-out A: 53 to 75 of 81.
Held-out B, untouched: 22 to 25 of 28. Held-out C, untouched: 28 to 33 of 45.

**fig-e-hook-false-positives.** Horizontal bar chart of the share of public commands the hook blocked
or asked about, before and after fixes, by source. package.json scripts 0.27% to 0.06%. README lines
0.98% to 0.61%. Makefile targets 5.34% to 0.42%. GitHub Actions steps 2.29% to 1.54%. Dockerfiles
4.78% to 4.36%. Manifest writes 7.60% to 2.61%.

**fig-f-hook-latency.** Horizontal bar chart of hook latency on a log scale with budget markers. A
command that installs nothing: 121 ms median, 177 ms at p95, within its budget. One install with a
warm cache: 358 and 372 ms, under 1 second. One install with a cold cache: 2.4 and 3.7 seconds, under
5 seconds.

**fig-g-architecture.** Diagram. A coding agent connects to pinright's MCP tools and to its
pre-install hook. Both feed a verdict pipeline (deps.dev, OSV, the package registries, an offline
list of popular names). The MCP tools also feed a docs pipeline (package files at the version, the
repository at its release tag, llms.txt, docs sites found from metadata). Both pipelines produce a
fenced answer (a security notice, docs inside untrusted-data blocks, or the hook's deny, ask or allow)
that returns to the agent.

**fig-h-what-the-agent-sees.** Terminal panel. The agent runs npm install lodash@4.17.20 and pinright
answers: "pinright blocked this dependency change: lodash@4.17.20 (npm) has 5 known advisories
(CVE-2021-23337, CVE-2026-4800, CVE-2020-28500, HIGH). Use 4.x release 4.18.1: npm install
lodash@4.18.1." The command does not run.

**fig-i-tokens-per-run.** Bar chart of thousands of tokens per run for three models and three arms,
with 95% intervals, in two panels. Agent benchmark: without tools 15 (Sonnet), 21 (Haiku), 16 (Opus);
pinright with its security layer off 56, 94, 73; pinright 42, 74, 55. Docs benchmark: without tools
17, 23, 19; security layer off 94, 135, 113; pinright 63, 95, 84.

## CLI renders (visuals/cli)

**pinright-doctor.** Terminal output of npx pinright doctor: Node version, response times of deps.dev,
OSV, the npm registry, PyPI, Packagist, jsDelivr and GitHub, all ok; the cache; no policy file; hook
startup of about 140 ms; no agent configured yet.

**pinright-check-lodash.** Terminal output of npx pinright check npm lodash@4.17.20: a security notice
listing five advisories, two high and three moderate, and the recommendation to install 4.18.1 on the
same 4.x line.

**pinright-audit-sarif.** Terminal output of npx pinright audit on a package.json a coding agent wrote:
2 of 29 packages have known advisories, 35 alerts (1 critical, 14 high), with the fix for axios and
form-data and the SARIF file written.

**pinright-sarif-summary.** Summary of the SARIF 2.1.0 file: 35 rules, 35 results (16 error, 18
warning, 1 note), each located at the package.json line that brings the package in, with a stable
fingerprint.

## Landing screenshots (visuals/landing)

**desktop-en / desktop-es.** The pinright page on hiperai.com, desktop width, English and Spanish:
hero, the benchmark numbers, the three pieces, install, privacy and the open-source section. Taken
before the v6 update; the numbers shown are the v5 ones.

**mobile-en-N / mobile-es-N.** The same page at phone width, one section per image.
