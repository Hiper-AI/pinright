# Team policy (`.pinright.json`)

A `.pinright.json` at the project root, committed with the code, gives every developer and every agent
the same rules. It is JSON with `//` comments allowed. Every key is optional:

```jsonc
{
  "allow": ["@acme/*"],                       // skip every check (private packages); "*" is a wildcard
  "deny": [
    "left-pad",                               // any ecosystem
    { "name": "request", "ecosystem": "npm", "reason": "unmaintained; use undici" }
  ],
  "licenses": {
    "deny": ["AGPL-*", "SSPL-*"],             // SPDX ids, "*" wildcard
    "allow": ["MIT", "Apache-2.0", "BSD-*", "ISC"]  // when set, anything else is denied
  },
  "severityThreshold": "high",                // low | moderate | high | critical
  "cooldownDays": 7,                          // minimum age of a recommended version
  "cooldown": "enforce",                      // warn | enforce
  "noFix": "severity",                        // severity | allow | ask | deny
  "onError": "ask",                           // allow | ask | deny
  "unverifiable": "ask",                      // allow | ask | deny (git/URL sources, other registries)
  "actionsPin": "warn"                        // off | warn | enforce (GitHub Actions pinned to a SHA)
}
```

| Key | Hook | MCP tools |
|---|---|---|
| `allow` | Listed names pass without a check. `allow` wins over `deny`. | No policy findings for them. |
| `deny` | Denied with the reason, before any lookup. Only new or changed lines of a manifest count. | `POLICY:` line in `check-package` and `get-docs`; every match in the tree in `check-manifest`. |
| `licenses` | A version whose license expression has no acceptable alternative is denied (`MIT OR AGPL-3.0` passes a deny on `AGPL-*`). A missing or non-SPDX license is a note. | Same, for the version checked; direct dependencies in `check-manifest`. |
| `severityThreshold` | When every advisory of a version is rated below it, the hook allows with a note. Unrated advisories and malware always count. Applies to transitive findings too. | Not applied: the tools report every advisory. |
| `cooldownDays`, `cooldown` | As `PINRIGHT_COOLDOWN_DAYS` and `PINRIGHT_HOOK_COOLDOWN`. | `cooldownDays` changes the recommended version. |
| `noFix`, `onError`, `unverifiable` | As `PINRIGHT_HOOK_NO_FIX`, `PINRIGHT_HOOK_ON_ERROR` and `PINRIGHT_HOOK_UNVERIFIABLE`. | |

Precedence is built-in defaults, then the file, then environment variables. Lists merge
(`PINRIGHT_ALLOW` adds to `allow`); single values from the environment replace the file's.

The built-in `onError` is `allow`, so installing pinright never blocks an offline laptop. The starter
file that `pinright init` writes sets `"onError": "ask"`: with it, a registry that is down or slowed
on purpose cannot turn the check off, and you approve each install by hand until it answers again.
A developer who works offline can set `PINRIGHT_HOOK_ON_ERROR=allow` for themselves.

A file that is not valid JSON, or has an unknown key or a wrong value, does not count as "no policy":
the hook denies every dependency change with the error until someone fixes the file, and the MCP tools
start their answer with `POLICY ERROR`. The agent can propose the fix: a write to
`.pinright.json` asks a human instead of being denied, as every change to the policy does.
