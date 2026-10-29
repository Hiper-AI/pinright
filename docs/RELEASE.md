# Releasing

Publishing is one deliberate step: a maintainer publishes a GitHub Release, then approves the
`npm-publish` environment. `.github/workflows/release.yml` does the rest. Before the first release,
someone with admin rights on GitHub and on npm has to finish the setup below. Nothing in this
repository does it for you.

## Before the first publish

### 1. Decide the name

The npm name is not final. If it changes, edit these places and nothing else:

- `package.json`: `name`, `mcpName` (`io.github.Hiper-AI/<name>`, spelled like the GitHub org
  login: the MCP Registry compares it byte for byte), and `bin` if the command changes too.
- Run `npm run dist:artifacts`. It rewrites `server.json` and the generated blocks of the README
  (per-client configs, install links) from `package.json`; a test fails while they are stale.
- `README.md` and `SECURITY.md`: the install commands and prose outside those blocks.
- Hook entries `init` wrote under the old name: `init` finds its own entries by the package name,
  so after a rename it adds a new entry next to the old one. Say so in the release notes.

`src/pkg.ts` reads the name from `package.json` at runtime: the server name agents see
(`SERVER_INFO`), the `User-Agent`, the launcher `init` writes (`npx -y <name>`), the server key in
every client config and the `.mcpb` manifest all follow it. The workflows and
`scripts/check-pack.mjs` read the name and version from `package.json` too.
`.safectx.json`, the `SAFECTX_*` variables and the cache directory also carry the name; they can
keep it even if the npm name changes.

Check that the name is free (`npm view <name>` returns 404) and that it does not sit one typo
away from a popular package: safectx's own typosquat check would flag it, and so would others.
A scoped name (`@hiperai/<name>`) avoids both problems and needs `--access public`, which the
workflow already passes.

### 2. GitHub repository

- [ ] Make the repository public. npm provenance only works from public repositories, and
      Scorecard publishes nothing for private ones (`scorecard.yml` skips itself until then).
- [ ] Branch protection (or a ruleset) on `main`: pull request required, at least one approving
      review, review from Code Owners (`.github/CODEOWNERS`), dismiss stale approvals, status
      checks required (`test (...)` for all six combinations, `self-audit`, `package contents`),
      no force pushes, no deletions, include administrators.
- [ ] Tag protection (ruleset on `refs/tags/v*`): only maintainers create, nobody updates or
      deletes. The release workflow publishes whatever `v<version>` points to.
- [ ] Environment `npm-publish` (Settings > Environments): required reviewers (you, plus one more
      person if possible), "Prevent self-review" if there is a second reviewer, deployment
      branches and tags limited to the tag pattern `v*`. No secrets in it: trusted publishing
      needs none.
- [ ] Settings > Actions > General: "Read repository contents" as the default `GITHUB_TOKEN`
      permission, and do not let Actions create or approve pull requests. Allow only actions
      pinned to a full SHA if the org offers that policy.
- [ ] Settings > Code security: private vulnerability reporting (SECURITY.md sends reporters
      there), Dependabot alerts and security updates, secret scanning and push protection.
- [ ] Runners. `ci.yml` and the `verify` job of `release.yml` run on Hiper AI's own runner
      (label `hiperai-ci`, VM `hiperai-ci-linux`). Register one for this repository there, as
      for the other repos: without it those jobs stay queued with no error. Two jobs still use
      GitHub-hosted minutes, because the services behind them reject self-hosted runners:
      `publish` in `release.yml` (npm trusted publishing and provenance) and `scorecard.yml`
      (`publish_results`). Both are about a minute each, the first once per release and the
      second weekly. GitHub-hosted runners must be able to start for them.
- [ ] Before making the repository public: Settings > Actions > General > "Require approval for
      all external contributors". `ci.yml` already skips pull requests from forks, so code from
      outside the organization never runs on the shared runner; this setting is the second lock.

### 3. npm

- [ ] The npm account that owns the package has 2FA with a security key or authenticator app.
- [ ] Add the trusted publisher (package Settings > Trusted publishing > GitHub Actions):
      organization `Hiper-AI`, repository `safectx`, workflow filename `release.yml`, environment
      `npm-publish`. Fields are case-sensitive. A new configuration must see a successful publish
      within 2 days or it expires.
- [ ] If npm does not let you add a trusted publisher before the package exists, bootstrap the
      first version through the same workflow, not from a laptop (provenance only comes from CI):
      create a granular access token that can publish only this package and expires in a day,
      store it as the secret `NPM_TOKEN` of the `npm-publish` environment, add
      `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the `env` of the Publish step in a PR,
      release, then delete the secret and the token, revert that line and add the trusted
      publisher.
- [ ] After the first trusted publish: package Settings > Publishing access > "Require two-factor
      authentication and disallow tokens". The workflow keeps working because it uses OIDC.
- [ ] Revoke any classic or automation token that can publish under the account.

## Each release

1. On a branch: bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`),
   update `package-lock.json`, note user-facing changes in the PR. Merge to `main` with CI green.
2. Tag the merge commit on `main`: `git tag -s v<version>` (signed if you can) and push the tag.
3. Draft a GitHub Release for that tag and publish it. A pre-release publishes under the npm
   dist-tag `next`; a normal release under `latest`.
4. Approve the `npm-publish` deployment when the workflow asks.

The workflow refuses to publish when the tag is not exactly `v` + the `package.json` version, or
when the tagged commit is not on `main`. The `verify` job runs typecheck, lint, tests, build, the
self-audit (lockfile, workflows, `npm audit signatures`), packs the tarball, checks its file list
and smoke-tests it from a clean install. The `publish` job holds the only `id-token: write`
permission, installs nothing, checks the tarball's SHA-256 against the one `verify` produced and
runs `npm publish` on it.

You can also run the workflow by hand (Actions > Release > Run workflow) with the tag and the
confirmation text `publish v<version>`. The same guards and approval apply.

## After a release

- `npm view <name>@<version> dist.attestations` shows the provenance attestation.
- `npm audit signatures` in a project that installs it verifies the signature and attestation.
- If a release is bad: `npm deprecate <name>@<version> "<reason>"` and publish a fixed version.
  `npm unpublish` is only possible within 72 hours and breaks anyone who pinned it.
