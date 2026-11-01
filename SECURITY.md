# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue, pull request or discussion for it.
If you cannot use GitHub, write to opensource@hiperai.com.

Include the version (`npx pinright --version`), the command or MCP tool call, and what you
expected. We aim to acknowledge a report within 3 business days and to agree a disclosure date
with you. Once a fix ships, we publish a GitHub Security Advisory and credit you unless you ask
us not to.

## Supported versions

Security fixes go to the latest 1.x release. Upgrade to it before reporting.

## What runs on your machine

- The package has no `preinstall`, `install` or `postinstall` scripts. Installing it runs no code.
- Its runtime dependencies are `@modelcontextprotocol/server`, `jsonc-parser`, `semver` and `zod`,
  pinned to exact versions. The only transitive one is `@modelcontextprotocol/core`, which comes in
  through the server package (`npm ls --omit=dev --all` lists the five). Each release is published from GitHub Actions with
  npm provenance, so `npm audit signatures` can tie the tarball to the commit and workflow that
  built it.
- It never executes what it downloads. Package archives, READMEs, type definitions and docs pages
  are parsed as text and handed to the agent as data.
- It reads dependency files (lockfiles, manifests, `.pinright.json`, workflow files) in the project
  you point it at. It writes only to its cache directory (`PINRIGHT_CACHE_DIR`, by default
  `<OS cache dir>/pinright`) and, when you run `pinright init`, to the agent configuration files that
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

The only credential, `GITHUB_TOKEN` / `GH_TOKEN`, is optional and goes only to `api.github.com`.
pinright never sends your source code, file contents or environment. The names and versions of the dependencies you check do reach
the services above, so a private package name you check does too.

## URLs that come from package metadata

The package's publisher picks the docs-site URL, the pages its `llms.txt` lists and the
announcement links in its GitHub release notes. A malicious package could point them at your
cloud metadata service or a host on your internal network, so pinright fetches those URLs through a
separate guard (`src/safeFetch.ts`). The guard:

- uses https only. It upgrades an `http://` link from metadata to `https://` on the same host and
  refuses a redirect to `http://`. Plain http would let anyone on the path inject text into what the
  agent reads.
- refuses credentials in the URL and any port other than the default one.
- refuses `localhost`, single-label names and names under `.local`, `.internal`, `.localdomain`,
  `.home.arpa` and similar suffixes before any DNS lookup.
- refuses literal addresses outside public unicast, after URL parsing has normalized decimal,
  octal and hex forms (`http://2130706433/` is `127.0.0.1`). The blocked ranges cover loopback,
  RFC 1918, CGNAT, link-local (`169.254.169.254`), multicast and reserved IPv4, and for IPv6
  everything outside `2000::/3` (`::1`, ULA `fc00::/7` such as `fd00:ec2::254`, link-local,
  site-local), documentation ranges, 6to4 and Teredo. For IPv4-mapped and NAT64 addresses it
  judges the IPv4 inside.
- resolves the name and refuses it if any address is not public. The check runs inside the
  socket's own lookup, and the socket connects to the address that passed, so a DNS answer that
  changes between check and connect (rebinding) cannot send the request inward.
- follows at most 3 redirects by hand and runs every check again on each hop.
- keeps a timeout over the whole exchange and a 10 MB cap on the body.

pinright treats whatever comes back as text. Requests to the fixed services in the table above
(registries, deps.dev, OSV, jsDelivr, GitHub) use the ordinary client. pinright accepts
a GitHub owner and repository from metadata only when they match GitHub's own name rules.

## Network settings

pinright uses Node's built-in `fetch`. Behind a corporate proxy, set `HTTPS_PROXY` (and `NO_PROXY`
if needed) together with `NODE_USE_ENV_PROXY=1`, which recent Node 22 and 24 releases honour
(checked on Node 24.20).
`PINRIGHT_TIMEOUT_MS` sets the per-request timeout.

Through a proxy, the proxy resolves and connects to the docs site, so pinright cannot pin the
address. It still applies the URL, name and literal-address checks and refuses a name whose local
DNS answer is not public. A name that answers differently to the proxy, or rebinds between the two
lookups, can get past that. If your proxy can reach internal services or cloud metadata, block
those destinations at the proxy. Hosts that `NO_PROXY` exempts get the direct, pinned connection.
