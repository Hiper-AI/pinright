# Releasing

A release is one deliberate step: a maintainer publishes a GitHub Release, then approves the
`npm-publish` environment. `.github/workflows/release.yml` does the rest. The first release needs
the one-time setup in the runbook below; nothing in this repository does it for you.

- [Launch runbook: 1.0.0 on Tuesday 2026-11-03](#launch-runbook-100-on-tuesday-2026-11-03)
- [Each release after that](#each-release)
- [Rollback](#rollback)

## Launch runbook: 1.0.0 on Tuesday 2026-11-03

Do the steps in order. Each one says what to check before you move on. Commands are for
PowerShell on Windows unless they say Git Bash; `gh` must be logged in as an admin of `Hiper-AI`.

### Why the first publish needs a bootstrap

npm cannot attach a trusted publisher to a package that does not exist yet. `npm help trust` says
so ("The package you're configuring must already exist on the npm registry"), and the package
settings page where you add one only appears once the package exists. Our workflow publishes only
through trusted publishing (OIDC), so the name has to exist before the workflow can publish
1.0.0. Checked against docs.npmjs.com/trusted-publishers and `npm help trust` (npm 11.19) on
2026-11-01.

| Option | What you do | Provenance on 1.0.0 | Cost |
|---|---|---|---|
| **A. Placeholder from your machine** (recommended) | Publish an empty `0.0.0-bootstrap.0` with 2FA, add the trusted publisher, then publish 1.0.0 from the workflow | Yes | A placeholder with no code sits on npm for a few minutes; you unpublish it |
| B. Short-lived token in the workflow | Granular token that can publish, stored in the `npm-publish` environment for one run; a PR adds `NODE_AUTH_TOKEN` to the Publish step, a second one reverts it | Yes | A publish token exists for a day; two PRs to `release.yml` on launch day |
| C. Real 1.0.0 from your machine | `npm publish` of the verified tarball with 2FA | No: provenance needs a CI identity | 1.0.0 is the one version `npm audit signatures` cannot tie to a commit, on a supply-chain tool |

Option A keeps every real version built and published by the workflow, with no token and no
change to `release.yml`. The placeholder holds a `package.json` and a README, no code and no
`bin`, so whoever installs it in those minutes runs nothing. The runbook follows option A.

### Monday (the day before)

- [ ] Everything for 1.0.0 is on `main`: the `release` branch (one commit, "pinright 1.0.0", with
      the launch README and the site) replaces `main` with a force push, and the old branches that
      name third-party docs services in their history (`feat/action`, `feat/docs-bench`,
      `feat/github-token`, `feat/injection`, `feat/pendientes`, `feat/ssrf`, `feat/supplychain`,
      `integracion`) are deleted from `origin` before the repository goes public. `main` CI is green:
      `test (node 20)`, `test (node 22)`, `test (node 24)`, `self-audit`, `package contents`. The
      release guard refuses a tag that is not on `origin/main`.
- [ ] No self-hosted runner is registered for this repository: every job runs on GitHub-hosted
      runners. `gh api repos/Hiper-AI/pinright/actions/runners --jq '.total_count'` prints `0`.
- [ ] `npm run ci:local` passes on the commit you will tag. It runs the CI checks on your machine
      (typecheck, lint, tests, build, client smoke test, self-audit, package contents, fresh
      `action-dist`), for the time before GitHub-hosted runners start.
- [ ] `npm view pinright` still returns `404 Not Found`.
- [ ] The npm account that will own the package has 2FA (security key or authenticator app), and
      `npm --version` on your machine is 11.5.1 or newer. Decide whether the package lives under
      your user or an npm org (an org lets a second person maintain it; add them now).
- [ ] The labels the issue templates use exist:
      `gh label create false-positive -R Hiper-AI/pinright -c D93F0B -d "Blocked or flagged when it should not be"`,
      then `false-negative` (B60205) and `docs-answer` (0E8A16) the same way. `bug` and
      `enhancement` exist by default.
- [ ] The site in `site/` builds clean (`cd site && npm ci && npm run build`) and is ready for
      Cloudflare Pages (project `pinright-site`, Direct Upload of `site/dist`). Until the deploy,
      `pinright.dev` keeps its 301 to `https://hiperai.com/pinright`; the deploy replaces the
      redirect rule and the Access bypass app stays. The product page on hiperai.com (website
      branch `feat/pinright`) links to the site.

### 1. Final check from a clean clone of `main` (about 10 minutes)

In Git Bash, in an empty directory:

```bash
git clone https://github.com/Hiper-AI/pinright.git && cd pinright
npm ci --ignore-scripts
npm run typecheck && npm run lint && npm test && npm run build
npm pack --ignore-scripts --json > pack.json && node scripts/check-pack.mjs pack.json
node -p "require('./package.json').version"     # 1.0.0
grep '"version"' server.json                     # 1.0.0, twice
```

Check: `check-pack` prints `ok: ... files`, the version is 1.0.0 everywhere, and
`CHANGELOG.md` has the `## [1.0.0] - 2026-11-03` entry.

### 2. Repository settings that do not need it public

Settings > Actions > General:
- "Require approval for all external contributors" (fork pull requests).
- Workflow permissions: "Read repository contents and packages permissions"; leave "Allow GitHub
  Actions to create and approve pull requests" off.
- If the org offers it: allow only actions pinned to a full commit SHA.

Settings > Code security: turn on private vulnerability reporting (SECURITY.md and the issue
chooser send reporters there), Dependabot alerts and security updates, secret scanning and push
protection.

Check: the Security tab shows "Report a vulnerability".

### 3. Make the repository public

**Do step 5 (bootstrap the name on npm) before this step.** Step 5 needs nothing public. Once
the repository is public, anyone who watches new repositories can publish `pinright` to npm
first, and the README tells every reader to run `npx -y pinright`. Check `npm view pinright
versions` shows `0.0.0-bootstrap.0` before you flip visibility.

Settings > General > Danger Zone > Change repository visibility > Public.

Check, right away:
- Security > Secret scanning: no open alerts. GitHub scans the whole history once the repository
  is public. If it finds something, rotate that credential before anything else.
- **GitHub-hosted runners start.** The org's GitHub-hosted runners are blocked by billing, and
  standard GitHub-hosted runners are free for public repositories. Every workflow needs them (npm
  trusted publishing and Scorecard's `publish_results` reject self-hosted runners, and CI runs
  there too). Prove it before you rely on it:

  ```powershell
  gh workflow run scorecard.yml -R Hiper-AI/pinright --ref main
  gh run list -R Hiper-AI/pinright --workflow scorecard.yml --limit 1
  gh run watch -R Hiper-AI/pinright (gh run list -R Hiper-AI/pinright --workflow scorecard.yml --limit 1 --json databaseId --jq '.[0].databaseId')
  ```

  The run must leave `queued` within a minute or two and finish `success`. If it stays queued, or
  the run page shows a billing or spending-limit message, stop: the `publish` job would hang the
  same way. Fix billing for the org (Settings > Billing and plans: payment method, Actions budget),
  or fall back to option C and accept 1.0.0 without provenance.

### 4. Protection rules (free on public repositories)

- Ruleset on `main` (Settings > Rules > Rulesets > New branch ruleset, target the default branch):
  pull request with 1 approval, review from Code Owners, dismiss stale approvals; required status
  checks `test (node 20)`, `test (node 22)`, `test (node 24)`, `self-audit`, `package contents`;
  block force pushes and deletions; empty bypass list.
- Ruleset on tags (New tag ruleset, include `refs/tags/v*`): restrict creations to maintainers,
  restrict updates, restrict deletions. The release workflow publishes whatever `v<version>`
  points to.
- Environment `npm-publish` (Settings > Environments > New environment): required reviewers (you,
  plus a second person if there is one, with "Prevent self-review"); Deployment branches and tags >
  Selected branches and tags > add the tag rule `v*`. No secrets in it.

Check: `gh api repos/Hiper-AI/pinright/environments/npm-publish --jq '.protection_rules[].type'`
lists `required_reviewers` and `branch_policy`.

### 5. Bootstrap the name on npm (your machine, about 5 minutes)

Create the placeholder in an empty directory outside the repository:

```powershell
$dir = New-Item -ItemType Directory -Force "$env:USERPROFILE\pinright-bootstrap"
Set-Location $dir
@'
{
  "name": "pinright",
  "version": "0.0.0-bootstrap.0",
  "description": "Name placeholder. Install pinright@latest.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/Hiper-AI/pinright.git" }
}
'@ | Out-File -Encoding ascii package.json
'Placeholder that reserved the name before the first release. Use npx -y pinright (1.0.0 or later).' | Out-File -Encoding ascii README.md
npm login
npm publish --tag bootstrap --access public
```

npm asks for the 2FA code. Check: `npm view pinright versions dist-tags` shows
`0.0.0-bootstrap.0`. If `latest` points at it too, that is fine for a package's first version;
step 7 moves `latest` to 1.0.0.

### 6. Add the trusted publisher (at most 2 days before step 7)

```powershell
npm trust github pinright --file release.yml --repository Hiper-AI/pinright --environment npm-publish --allow-publish
npm trust list pinright
```

Or on npmjs.com: package > Settings > Trusted publishing > GitHub Actions, organization
`Hiper-AI`, repository `pinright`, workflow filename `release.yml`, environment `npm-publish`.
Fields are case-sensitive. A configuration that sees no successful publish within 2 days expires
and has to be created again.

Check: `npm trust list pinright` shows the GitHub entry with publish allowed.

### 7. Tag and release 1.0.0

Tag the commit on `main` that has the 1.0.0 bump (Git Bash):

```bash
git fetch origin
git tag -s v1.0.0 origin/main -m "pinright 1.0.0"    # -a instead of -s if you do not sign tags
git push origin v1.0.0
```

Save the 1.0.0 section of `CHANGELOG.md` to `notes.md`, then:

```bash
gh release create v1.0.0 -R Hiper-AI/pinright --title "pinright 1.0.0" --notes-file notes.md
```

Publishing the release starts `release.yml`. `verify` builds and checks the tarball; then `publish` waits
for you: open the run (Actions > Release) and approve `npm-publish`.

Check, in order:
- The run is green. If `verify` fails, nothing was published: reject the deployment if it is
  waiting, delete the release and tag (`gh release delete v1.0.0 -R Hiper-AI/pinright --cleanup-tag`),
  fix on `main` and repeat this step.
- `npm view pinright dist-tags` shows `latest: '1.0.0'`.
- `npm view pinright@1.0.0 dist.attestations` shows a provenance attestation.
- In an empty directory: `npm init -y`, `npm install pinright@1.0.0`, `npm audit signatures`
  reports verified signatures and attestations, and `npx --no-install pinright --version` prints
  `1.0.0`.
- `npx -y pinright@latest init claude --print` prints the config and writes nothing.

### 8. Retire the placeholder and lock publishing

```powershell
npm unpublish pinright@0.0.0-bootstrap.0
npm dist-tag rm pinright bootstrap
```

npm allows unpublishing one version in its first 72 hours while no public package depends on it.
If it refuses, deprecate it instead:
`npm deprecate pinright@0.0.0-bootstrap.0 "Placeholder. Use pinright@latest."`.

Then on npmjs.com: package > Settings > Publishing access > "Require two-factor authentication
and disallow tokens". The workflow keeps working because it uses OIDC. Revoke any classic or
automation token on the account that can publish (`npm token list`, `npm token revoke <id>`).

Check: `npm view pinright versions` lists only `1.0.0` (or the placeholder shows as deprecated).

### 9. MCP Registry and listings

Follow [LAUNCH-LISTINGS.md](LAUNCH-LISTINGS.md): the official MCP Registry first (it reads the npm
package), then Glama, then the rest.

### 10. Landing page and pinright.dev

Build `site/` and upload `site/dist` to Cloudflare Pages (`npx wrangler pages deploy dist
--project-name pinright-site` from `site/`), then point the `pinright.dev` DNS at the Pages project
and delete the 301 redirect rule. Check the domain before you link it anywhere (Git Bash):

```bash
curl -sI https://pinright.dev | grep -iE '^(HTTP|location)'       # 200, no location header
curl -sI https://www.pinright.dev | grep -iE '^(HTTP|location)'   # 301 to https://pinright.dev/
curl -s -o /dev/null -w '%{http_code}\n' https://pinright.dev/llms.txt     # 200
curl -s -o /dev/null -w '%{http_code}\n' https://pinright.dev/report.pdf   # 200
```

Open `https://pinright.dev` in a private window too: the certificate must be valid and the page
must load. Only then use `pinright.dev` in announcements. `package.json` keeps the GitHub
repository as `homepage` until the redirect has worked for a few days; switching it is a
one-line change in the next release.

### 11. Announce

Only after steps 7 to 10 pass. Link the repository, the landing page and the technical report.

## Each release

1. On a branch: bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`),
   run `npm run dist:artifacts` (updates `server.json` and the `.mcpb` manifest), and move the
   "Unreleased" notes in `CHANGELOG.md` under the new version. Land it on `main` with CI green.
2. Tag the commit on `main`: `git tag -s v<version>` and push the tag.
3. Create a GitHub Release for that tag and publish it. A pre-release publishes under the npm
   dist-tag `next`; a normal release under `latest`.
4. Approve the `npm-publish` deployment when the workflow asks.
5. `mcp-publisher publish` for the MCP Registry (see LAUNCH-LISTINGS.md).

The workflow refuses to publish when the tag is not exactly `v` + the `package.json` version, or
when the tagged commit is not on `main`. The `verify` job runs typecheck, lint, tests, build, the
self-audit (lockfile, workflows, `npm audit signatures`), packs the tarball, checks its file list
and smoke-tests it from a clean install. The `publish` job holds the only `id-token: write`
permission, installs nothing, checks the tarball's SHA-256 against the one `verify` produced and
runs `npm publish` on it.

You can also run the workflow by hand (Actions > Release > Run workflow) with the tag and the
confirmation text `publish v<version>`. The same guards and approval apply. Pick the tag itself
in "Use workflow from" (`gh workflow run release.yml --ref v<version> ...`): the `npm-publish`
environment only admits refs matching `v*`, so a run started from `main` stops at the publish job.

## Rollback

- **Before `publish` is approved:** reject the deployment in the run. Nothing reached npm. Delete
  the release and the tag (`gh release delete v<version> --cleanup-tag`), fix on `main`, tag again.
- **A published version is broken:** publish a fixed patch version the normal way, then
  `npm deprecate pinright@<bad> "<what is wrong>; use <fixed>"`. To move `latest` back first:
  `npm dist-tag add pinright@<good> latest`.
- **Unpublish** only when the version must not be installable at all (it leaks something, or it
  is malicious). npm allows it within 72 hours of publishing if no public package depends on it;
  after that, only with no dependents, fewer than 300 downloads in the last week and a single
  owner. A version number can never be used again, even after unpublishing. Unpublishing every
  version blocks the name for 24 hours.
- **The MCP Registry entry** follows `server.json`; publish the fixed version there as well.
- **A compromised publish path:** remove the trusted publisher (`npm trust revoke pinright --id=<id>`),
  deprecate the affected versions and publish a GitHub Security Advisory.

## After a release

- `npm view pinright@<version> dist.attestations` shows the provenance attestation.
- `npm audit signatures` in a project that installs it verifies the signature and attestation.
