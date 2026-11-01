**What the agent sees.** The answer `pinright hook claude` returned on 2026-11-01 when the agent's
next tool call was `npm install lodash@4.17.20` (Claude Code `PreToolUse`, `permissionDecision:
deny`). The command does not run. The message names the advisories and the clean release on the
same 4.x line, 4.18.1, with the command to install it. It matches the README's quick start word for
word. The panel is a rendering of the reason text; the window chrome is generic, not a screenshot of
a product.

Source: `visuals/cli/hook-block.txt` (captured from `dist/cli.js hook claude` with a JSON payload on
stdin); README "Quick start".
Use: report Figure 2, the landing's hook example, social cards. Files: `fig-h-what-the-agent-sees{,-dark}.{svg,png}`.
