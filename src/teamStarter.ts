/**
 * The team policy file's name and the starter `safectx init` writes. Apart from
 * teamConfig.ts (schema, registry lookups) so the CLI can name the file without
 * loading the validator: the hook starts on every agent command.
 */
export const CONFIG_FILE = '.safectx.json';

/** The starter file `safectx init` writes. Comments are allowed; safectx strips them. */
export const STARTER_CONFIG = `{
  // safectx team policy. Versioned with the repo; environment variables override it.
  // Every key is optional; see "Team policy" in the safectx README.

  // Private or vetted packages that skip every check. "*" is a wildcard.
  "allow": [],

  // Packages nobody may add. A string, or { "name", "ecosystem", "reason" }.
  "deny": [
    // { "name": "request", "ecosystem": "npm", "reason": "unmaintained; use undici or fetch" }
  ],

  // SPDX license ids. With "allow", anything not listed is denied. Unknown licenses are noted, not denied.
  "licenses": {
    "deny": ["AGPL-*", "SSPL-*"]
  },

  // Advisories below this severity (low, moderate, high, critical) are notes, not blocks.
  "severityThreshold": "low",

  // Days a release must age before it is recommended; "enforce" blocks unpinned installs inside it.
  "cooldownDays": 3,
  "cooldown": "warn",

  // When no clean version exists: "severity" asks for high/critical and allows the rest; or allow, ask, deny.
  "noFix": "severity",

  // When deps.dev or OSV cannot be reached: allow, ask or deny.
  "onError": "allow",

  // What safectx cannot check (git or URL sources, another registry, a command it cannot read): allow, ask or deny.
  "unverifiable": "ask"
}
`;
