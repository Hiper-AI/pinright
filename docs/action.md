# GitHub Action and CI

The repository root is a GitHub Action. It runs `pinright audit`, writes a job summary,
annotates the pull request and uploads SARIF, so the findings land in Security > Code
scanning on the manifest or lockfile line that brings each package in.

```yaml
name: dependencies
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '17 6 * * 1'   # new advisories appear without a commit

permissions:
  contents: read

jobs:
  pinright:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # upload-sarif; drop it with upload-sarif: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: Hiper-AI/pinright@<commit SHA> # pin the release you reviewed
        with:
          fail-on: high
```

| Input | Default | Meaning |
|---|---|---|
| `path` | `.` | Directory, dependency file or workflow, relative to the workspace. A directory also gets its `.github/workflows` and `action.yml` checked. |
| `fail-on` | `high` | Lowest advisory severity that fails the step: `low`, `moderate`, `high`, `critical`, or `none` to report only. |
| `sarif` | `true` | Write SARIF (output `sarif-file`). |
| `upload-sarif` | `true` | Upload it with `github/codeql-action/upload-sarif` (pinned by SHA in `action.yml`). |
| `category` | `pinright` | Code scanning category. Give each run its own when you audit several paths. |
| `config` | nearest `.pinright.json`; on a pull request, the base commit's | Team policy file. When set, it wins over both. |
| `supply-chain` | `true` | Typosquat, registry, deprecation and risk checks of direct dependencies, one lookup each. |
| `annotations` | `true` | Annotate the worst findings on the pull request diff. |
| `github-token` | `github.token` | Resolves action tags to commits and authenticates the upload. |

Outputs: `exit-code` (0 clean, 1 findings, 2 bad input, 3 the audit could not run),
`sarif-file` and `results`.

On `pull_request` and `pull_request_target` events the action reads `.pinright.json` from the
pull request's base commit (`pull_request.base.sha` in the event, else `GITHUB_BASE_REF`), never
from the PR's own tree: otherwise a PR could add `"allow": ["*"]` and skip the checks on the change
under review. When the PR adds, changes or deletes the policy, the run posts a notice so reviewers
see it, and the new policy applies once the PR is merged. `actions/checkout` fetches one commit by
default, so pinright fetches the base commit itself. On a public repository that works with
`persist-credentials: false`, as in the example above; on a private one, keep the default
credentials or set `fetch-depth: 0`. If the base cannot be read, the step fails (exit 2) with that
advice instead of falling back to the PR's policy. Passing `config:` turns this off.

The action carries its own Node bundle (`action-dist/index.mjs`, built by
`npm run bundle:action` from `src/action/main.ts`), so a run installs nothing from npm. It uses
the runner's Node (20.9 or newer) and sets up Node 22 with `actions/setup-node` only when the
runner lacks one, so it also works on self-hosted Linux, macOS and Windows runners (it needs
`bash`, which Git for Windows provides). A self-test workflow rebuilds the bundle on each pull request and fails if the
committed file differs from the source.

Code scanning on a private repository needs GitHub Code Security (part of GitHub Advanced
Security), sold for Team and Enterprise plans. Without it, set `upload-sarif: false`: you still
get the job summary, the annotations and the exit code, and you can keep the SARIF as an
artifact.

Each result has a stable `primaryLocationLineHash` built from the rule, the file and the
package name, without line or version, so GitHub keeps one alert per advisory and package
across lockfile churn and closes it when you fix the package. Rules: one per advisory (GHSA
id, CVE in the description and tags, `security-severity` from the CVSS v3 vector or the GitHub
severity), plus `pinright/malware`, `pinright/typosquat`, `pinright/unknown-package`,
`pinright/unpublished-version`, `pinright/deprecated`, `pinright/policy-deny`,
`pinright/policy-license`, `pinright/risk/<signal>`, `pinright/action-unpinned`,
`pinright/action-missing-ref` and `pinright/action-unverified`.
