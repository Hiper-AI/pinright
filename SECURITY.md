# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue, pull request or discussion for it.

Include the version (`npx safectx --version`), the command or MCP tool call, and what you
expected. We aim to acknowledge a report within 3 business days and to agree a disclosure date
with you. Once a fix ships, we publish a GitHub Security Advisory and credit you unless you ask
us not to.

## Supported versions

The project is pre-1.0. Only the latest published minor release receives security fixes; upgrade
to it before reporting.

## What runs on your machine

- The package has no `preinstall`, `install` or `postinstall` scripts. Installing it runs no code.
- Its runtime dependencies are `@modelcontextprotocol/server` (and its `@modelcontextprotocol/core`),
  `semver` and `zod`, pinned to exact versions. Each release is published from GitHub Actions with
  npm provenance, so `npm audit signatures` can tie the tarball to the commit and workflow that
  built it.
- It never executes what it downloads. Package archives, READMEs, type definitions and docs pages
  are parsed as text and handed to the agent as data.
- It reads dependency files (lockfiles, manifests, `.safectx.json`, workflow files) in the project
  you point it at. It writes only to its cache directory (`SAFECTX_CACHE_DIR`, by default
  `<OS cache dir>/safectx`) and, when you run `safectx init`, to the agent configuration files that
  command names.

## What it sends over the network, and to whom

No telemetry. Every request goes from your machine to a public service, for the package you asked
about:

| Service | What it receives | When |
|---|---|---|
| `api.deps.dev` | ecosystem, package name, version | every check |
| `api.osv.dev` | ecosystem, package name, version | every check |
| Registries: `registry.npmjs.org`, `api.npmjs.org`, `pypi.org`, `pypistats.org`, `crates.io`, `rubygems.org`, `repo.packagist.org`, `packagist.org` | package name, version | checks, risk signals, docs |
| `cdn.jsdelivr.net`, `data.jsdelivr.com` | package name, version, file path | docs from the published package |
| `api.github.com`, `raw.githubusercontent.com` | repository, tag, file path | docs from the repo, upgrade guides, GitHub Actions audit |
| The package's own docs site | a request for `/llms.txt`, `/llms-full.txt` and the pages it lists | docs and upgrade guides, when the package metadata names a site |
| `context7.com` | library id and the agent's docs question | only when local docs are thin; `SAFECTX_CONTEXT7=off` turns it off |

Credentials are optional and stay with their service: `GITHUB_TOKEN` / `GH_TOKEN` goes only to
`api.github.com`, and `CONTEXT7_API_KEY` only to `context7.com`. safectx never sends your source
code, file contents or environment. The names and versions of the dependencies you check do reach
the services above, so a private package name you check does too.

The docs-site row deserves a note: the site URL comes from the package's own metadata, which its
publisher controls. safectx skips code hosts and non-HTTP URLs there, and treats whatever comes
back as text, but the request itself goes to that host.

## Network settings

safectx uses Node's built-in `fetch`. Behind a corporate proxy, set `HTTPS_PROXY` (and `NO_PROXY`
if needed) together with `NODE_USE_ENV_PROXY=1`, which recent Node 22 and 24 releases honour
(checked on Node 24.20).
`SAFECTX_TIMEOUT_MS` sets the per-request timeout.
