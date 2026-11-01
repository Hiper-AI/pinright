**How pinright answers.** The coding agent reaches pinright two ways: it calls the MCP tools
(`check-packages`, `check-package`, `check-manifest`, `find-library`, `get-docs`, `upgrade-guide`),
or the pre-install hook runs before its next shell command or file write. Both use the verdict
pipeline: deps.dev (versions, advisories, dependency graphs, Scorecard), OSV (advisory details, fixed
versions, malware records), the registries (existence, install scripts, provenance, publisher) and an
offline list of popular names for lookalikes. The MCP tools also use the docs pipeline: the package's
own files at the version, its repository at the release tag through jsDelivr, `llms.txt` /
`llms-full.txt`, and docs sites found from the package's metadata, normalized, scanned for prompt
injection and ranked with BM25. The answer goes back fenced: a security notice with the version to
pin, docs inside `<untrusted-data>` blocks, or the hook's deny, ask or allow.

Source: `src/` (server.ts, hook/, verdict.ts, docs/, untrusted/, safeFetch.ts); README.
Use: report Figure 1, the "how it works" section of the landing. Files: `fig-g-architecture{,-dark}.{svg,png}`.
