# Install pinright

Node 20.9 or newer. Two ways in:

```bash
# Just you, in every project: your user files, started from the installed binary.
npm i -g pinright
pinright init claude --user    # or cursor, codex, gemini, vscode, ...
pinright doctor                # optional: shows what answers, what is wired, what is missing

# Your team: project files that everyone gets from the repository.
npx -y pinright init           # the clients this project already uses; then commit the files
```

The project files start pinright with `npx -y pinright`, which works on any machine with Node and
needs no install, at about 1 s per agent tool call on Windows. Your user files start the installed
binary, at about 0.2 s (see [Latency](hook.md#latency)). Pick one per project: when a project commits its
hook, a user hook with a different command would run beside it, so `init --user` leaves the hook out
there and says why (see [Choosing a launcher and a scope](#choosing-a-launcher-and-a-scope)).

Restart the agent so it picks up the MCP server and the hook ([Clients](#clients) lists what each one needs). [The hook](hook.md) shows what the agent gets back once it is wired.

## Choosing a launcher and a scope

`init` adds pinright to an agent client: the MCP server, the pre-install hook when the client has
hooks, and a starter [`.pinright.json`](policy.md) for the project.

```bash
pinright init                  # the clients this project already uses (Claude Code if none)
pinright init cursor           # one client, in this project
pinright init codex --user     # one client, for your user instead of this project
pinright init vscode --print   # print what it would write and write nothing
```

Each line works the same as `npx -y pinright init ...`. What changes is the command `init` writes
for the agent, and `init` prints it next to each file with the reason:

- Project files (`.mcp.json`, `.claude/settings.json`, `.cursor/`, `.vscode/`, `.github/hooks/`,
  `.gemini/`, `.codex/` in the repo) get `npx -y pinright` and `npx -y pinright hook <agent>`. A team
  commits them, and they work on any machine with Node, at about 1 s per hook call on Windows.
  Pinning the major (`pinright@1`) does not avoid npx's registry lookup, so `init` does not pin it.
- Your user files (`--user`, and clients that only have user files) get `pinright` and
  `pinright hook <agent>` when a global install is on your PATH: about 0.2 s per hook call. `init`
  checks that this `pinright` is the package (its `package.json`, not a project's
  `node_modules/.bin` or npx's cache) and of the same major; without one, they get npx too.
- `--bin` writes the binary into project files as well, for teams that all install pinright
  globally. A teammate without it gets a hook that does not start, and the agent then runs the tool
  unchecked; `init` says so and `doctor` warns. `--npx` writes npx everywhere.

One pinright hook per client: Claude Code merges the hooks of the user and the project settings and
runs both when their commands differ (it merges identical commands into one). A user hook through
the binary does not make a project with a committed npx hook faster; both run, the check happens
twice and the agent waits for the slower one. So `init --user` leaves the hook out of the user file
while you run it in a project that has its own, and says why; `init` in a project with a different
user hook writes the project's hook, which the team needs, and notes the double check. `doctor`
warns about both cases.

What `init` does to your files:

- It edits only the `pinright` entry. Other servers, other hooks and comments (JSONC) stay as you
  left them, and so does the indentation, except that an entry written on one line next to the new
  one can come back spread over several lines. In a Codex `config.toml` it replaces the
  `[mcp_servers.pinright]` table and leaves the other lines alone.
- Before it changes a file, it copies it to `<file>.pinright.bak`. A second run finds nothing to
  change and writes nothing.
- If a file does not parse, `init` stops before it writes anything and tells you which file.
- It never writes a token. If an entry it replaces already sets variables, it keeps them and
  warns about any that look like a credential. `--gh-cli` adds `PINRIGHT_GH_CLI=1` instead.
- `--project` (the default where the client has a project file) or `--user` picks the scope.
  Windsurf has no project MCP file, so `init windsurf` writes your user files (server and hook)
  without `--user` and creates no `.pinright.json`; its output says so.
  `--no-hook`, `--no-mcp` and `--no-config` skip a part. The starter `.pinright.json` never replaces
  an existing one.

With no client named, `init` sets up the clients whose directory or config is already in the
project (`.cursor/`, `.vscode/`, `.gemini/`, `.codex/`, `opencode.json`, ...). It lists the clients
installed for your user and the command for each, but leaves their user-level files alone.

No key is required. A `GITHUB_TOKEN` helps with large monorepos and upgrade guides; see
[GitHub rate limit](cli.md#github-rate-limit). Put it in the environment that starts your agent.

## Install links

<!-- generated:install-links (scripts/distribution.ts; do not edit by hand) -->
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pinright&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBpbnJpZ2h0Il19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_pinright-0098FF?style=flat-square)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pinright%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pinright%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_pinright-24bfa5?style=flat-square)](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pinright%2522%252C%2522type%2522%253A%2522stdio%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pinright%2522%255D%257D)
<!-- /generated:install-links -->

These links add the MCP server only. Run `init` in the project for the hook.

## Clients

| Client | MCP server | Pre-install hook | `init` |
|---|---|---|---|
| Claude Code | yes | yes (`PreToolUse`) | yes |
| Claude Desktop | yes | no hooks in the app | yes, or the `.mcpb` extension below |
| Cursor | yes | yes (`beforeShellExecution`, `preToolUse`) | yes |
| VS Code (GitHub Copilot) | yes | yes, preview (`.github/hooks`) | yes |
| Windsurf (Devin Desktop) | yes, user only | yes (`pre_run_command`, `pre_write_code`) | yes |
| OpenAI Codex | yes | yes (`PreToolUse`, Bash and `apply_patch`) | yes |
| Gemini CLI | yes | yes (`BeforeTool`) | yes |
| Zed | yes | no hooks (`agent.tool_permissions` deny lists only) | yes |
| JetBrains Junie | yes | no hooks | yes |
| JetBrains AI Assistant | yes, in the IDE settings | no hooks | prints the JSON to paste |
| Cline | yes, user only | not wired: Cline hooks are executable files and run on macOS and Linux only | yes |
| Roo Code | yes, project only | no hooks | yes |
| Continue | yes, project only | no hooks | yes |
| Amp | yes | not wired: Amp intercepts tools through TypeScript plugins | yes |
| opencode | yes | not wired: opencode intercepts tools through JS plugins | yes |
| Kiro | yes | not wired: Kiro's docs do not describe the tool input a hook receives | yes |

Where a client has no hook, the MCP tools still give the agent the verdict when it asks for one,
and `pinright audit` in CI catches what got through.

Some clients need one more step after `init`:

- Codex reads a project's `.codex/` only when you trust the project, and runs a new hook only after
  you review it in `/hooks`.
- Gemini CLI asks before it runs a project hook it has not seen.
- Claude Code asks once to approve the servers in `.mcp.json`. Amp needs `amp mcp approve pinright`
  for a workspace server.
- Claude Desktop and Windsurf load the server after a restart (Windsurf: refresh the MCP list).
- VS Code hooks are a preview. The Copilot agent reads `.github/hooks/`; for local agent sessions,
  turn on `chat.useHooks`.

On native Windows, a client that cannot start `npx` (or the global `pinright`) directly works with
`cmd` as the command and `["/c", "npx", "-y", "pinright"]` (or `["/c", "pinright"]`) as the arguments.
Claude Code starts both directly.

<!-- generated:clients (scripts/distribution.ts; do not edit by hand) -->
#### Claude Code

Server: project `.mcp.json`; user `~/.claude.json`.
Hook (`pinright hook claude`): project `.claude/settings.json`; user `~/.claude/settings.json`.

```bash
npx -y pinright init claude
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Claude Desktop

Server: user `~/.config/Claude/claude_desktop_config.json` (Linux), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```bash
npx -y pinright init claude-desktop
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Cursor

Server: project `.cursor/mcp.json`; user `~/.cursor/mcp.json`.
Hook (`pinright hook cursor`): project `.cursor/hooks.json`; user `~/.cursor/hooks.json`.

```bash
npx -y pinright init cursor
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### VS Code (GitHub Copilot)

Server: project `.vscode/mcp.json`; user `~/.config/Code/User/mcp.json` (Linux), `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%\Code\User\mcp.json` (Windows).
Hook (`pinright hook copilot`): project `.github/hooks/pinright.json`; user `~/.copilot/hooks/pinright.json`.

```bash
npx -y pinright init vscode
```

```json
{
  "servers": {
    "pinright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Windsurf (Devin Desktop)

Server: user `~/.config/devin/mcp_config.json` (Linux, macOS), `%APPDATA%\devin\mcp_config.json` (Windows).
Hook (`pinright hook windsurf`): project `.devin/hooks.json`; user `~/.codeium/windsurf/hooks.json`.

```bash
npx -y pinright init windsurf
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Zed

Server: project `.zed/settings.json`; user `~/.config/zed/settings.json` (Linux, macOS), `%APPDATA%\Zed\settings.json` (Windows).

```bash
npx -y pinright init zed
```

```json
{
  "context_servers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### JetBrains Junie

Server: project `.junie/mcp/mcp.json`; user `~/.junie/mcp/mcp.json`.

```bash
npx -y pinright init junie
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### JetBrains AI Assistant

AI Assistant keeps its MCP servers in the IDE settings, not in a file pinright can edit. Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add > STDIO, and paste:

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### OpenAI Codex

Server: project `.codex/config.toml`; user `~/.codex/config.toml`.
Hook (`pinright hook codex`): project `.codex/hooks.json`; user `~/.codex/hooks.json`.

```bash
npx -y pinright init codex
```

```toml
[mcp_servers.pinright]
command = "npx"
args = ["-y", "pinright"]
```

#### Gemini CLI

Server: project `.gemini/settings.json`; user `~/.gemini/settings.json`.
Hook (`pinright hook gemini`): project `.gemini/settings.json`; user `~/.gemini/settings.json`.

```bash
npx -y pinright init gemini
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Cline

Server: user `~/.cline/data/settings/cline_mcp_settings.json`.

```bash
npx -y pinright init cline
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Roo Code

Server: project `.roo/mcp.json`.

```bash
npx -y pinright init roo
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### Continue

Server: project `.continue/mcpServers/pinright.yaml`.

```bash
npx -y pinright init continue
```

```yaml
name: pinright
version: 0.0.1
schema: v1
mcpServers:
  - name: pinright
    type: stdio
    command: "npx"
    args: ["-y", "pinright"]
```

#### Amp

Server: project `.amp/settings.json`; user `~/.config/amp/settings.json`.

```bash
npx -y pinright init amp
```

```json
{
  "amp.mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```

#### opencode

Server: project `opencode.json`; user `~/.config/opencode/opencode.json`.

```bash
npx -y pinright init opencode
```

```json
{
  "mcp": {
    "pinright": {
      "type": "local",
      "command": ["npx", "-y", "pinright"],
      "enabled": true
    }
  }
}
```

#### Kiro

Server: project `.kiro/settings/mcp.json`; user `~/.kiro/settings/mcp.json`.

```bash
npx -y pinright init kiro
```

```json
{
  "mcpServers": {
    "pinright": {
      "command": "npx",
      "args": ["-y", "pinright"]
    }
  }
}
```
<!-- /generated:clients -->

## Claude Desktop extension

`npm run build:mcpb` builds `build/mcpb/pinright-<version>.mcpb`, a Claude Desktop extension that
bundles the server with its dependencies and asks for an optional GitHub token, which Claude Desktop
keeps in the OS keychain. The build validates the manifest against the MCPB 0.3 schema and with the
official `mcpb` CLI. It is not published anywhere yet.
