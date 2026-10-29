/**
 * The CLI's words: usage for each command, the exit codes, "did you mean" for
 * a mistyped command, and colors that appear only on a terminal. Kept apart
 * from cli.ts so `safectx --help` loads nothing else.
 */
import { editDistance } from './typosquat.js';
import { CLIENTS } from './clients/registry.js';
import { INIT_USAGE } from './clients/init.js';
import { HOOK_AGENTS } from './hook/run.js';

/**
 * Colors only for a terminal that wants them: NO_COLOR (any value) and TERM=dumb
 * turn them off, FORCE_COLOR turns them on even through a pipe.
 */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export function paint(on: boolean) {
  const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39) };
}

export const EXIT_CODES = `Exit codes:
  0  done; for check, audit and doctor: nothing at or above the threshold
  1  check: the verdict is not "ok" (including "unknown": not verified)
     audit: findings at or above --fail-on
     upgrade: no target version found
     doctor: a check failed
  2  usage error (unknown command, missing or bad argument)
  hook always exits 0 with its decision on stdout; 1 only if it crashed,
  which Claude Code and Cursor treat as "proceed".`;

const ECOS = 'npm|pypi|cargo|go|maven|nuget|rubygems|composer';

interface CommandHelp {
  usage: string;
  summary: string;
  details: string;
}

export const COMMANDS: Record<string, CommandHelp> = {
  serve: {
    usage: 'safectx [serve]',
    summary: 'Run the MCP server on stdio (what Claude Code, Cursor and other agents launch).',
    details: `Tools: find-library, get-docs, check-package, check-packages, check-manifest, upgrade-guide.
"safectx mcp" is the same. The server logs to stderr only; stdout is the protocol.`,
  },
  hook: {
    usage: `safectx hook <${HOOK_AGENTS.join('|')}>`,
    summary: 'Pre-install hook: reads the agent hook JSON on stdin, answers allow, ask or deny.',
    details: `Wired by "safectx init". Runs before every shell command and manifest or workflow write;
the full command and write parser runs first, and only a dependency change loads the checks.
Unknown agent or input that is not JSON: exit 1 with a note on stderr (never a block).
Environment: SAFECTX_HOOK_TIMEOUT_MS (default 45000), SAFECTX_HOOK_ON_ERROR=allow|ask|deny.`,
  },
  check: {
    usage: `safectx check <${ECOS}> <name>[@version | ==version | version]`,
    summary: 'Security verdict for one package (latest, or the given version).',
    details: `Examples:
  safectx check npm express@4.17.1
  safectx check pypi requests==2.31.0
  safectx check cargo tokio`,
  },
  audit: {
    usage:
      'safectx audit [path] [--fail-on low|moderate|high|critical|none] [--json] [--sarif <file>] [--sarif-root <dir>] [--config <.safectx.json>] [--no-supply-chain]',
    summary: 'Audit every lockfile and manifest under a directory (the whole dependency tree).',
    details: `--fail-on      lowest severity that makes the exit code 1 (default: low; none never fails)
--json         machine-readable output on stdout
--sarif <file> also write SARIF 2.1.0 (for GitHub code scanning)
--config       a .safectx.json other than the nearest one
--no-supply-chain  skip the install-script, provenance and publisher signals`,
  },
  upgrade: {
    usage: `safectx upgrade <${ECOS}> <name> <from> [to] [--query="..."] [--tokens=N]`,
    summary: 'What breaks between two versions: changelog, migration guide and API changes.',
    details: `Without "to", the newest version without known advisories.
--query   narrow the guide to what the code uses ("useRouter middleware")
--tokens  answer budget (about 4 characters per token)`,
  },
  init: {
    usage: INIT_USAGE.split('\n')[0].replace(/^usage: /, ''),
    summary: 'Wire safectx into an agent: MCP server, hook where the client has one, and a starter .safectx.json.',
    details: `Without a client: the ones this project already uses (Claude Code if none). Merges into existing
configs and keeps a backup; never writes a token.
--project / --user  where to write (default: the client's usual scope)
--print   show what would be written, change nothing
--gh-cli  let safectx read the GitHub CLI login (SAFECTX_GH_CLI=1)
Clients: ${CLIENTS.map((c) => c.id).join(', ')}`,
  },
  doctor: {
    usage: 'safectx doctor [--json] [--offline]',
    summary: 'Check the setup: Node, upstream reachability, cache, GitHub auth, agent wiring, .safectx.json.',
    details: `Reads client configs, never changes them, and never prints a token.
--offline  skip the network probes`,
  },
  cache: {
    usage: 'safectx cache clear|prune|path',
    summary: 'The on-disk cache of registry and advisory answers.',
    details: `clear  delete the whole cache
prune  delete expired entries, then the oldest until it fits SAFECTX_CACHE_MAX_MB
path   print where it lives (SAFECTX_CACHE_DIR to move it)`,
  },
};

const ALIASES: Record<string, string> = { mcp: 'serve' };

export function canonical(cmd: string): string | undefined {
  if (cmd in COMMANDS) return cmd;
  return ALIASES[cmd];
}

/** The candidate a typo most likely meant: one edit for short words, two for longer ones, or a unique prefix. */
export function closest(word: string, candidates: string[]): string | undefined {
  const w = word.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const name of candidates) {
    const d = editDistance(w, name);
    if (!best || d < best.d) best = { name, d };
  }
  if (best && best.d <= (w.length > 4 ? 2 : 1)) return best.name;
  const prefixed = candidates.filter((n) => w.length >= 2 && n.startsWith(w));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** The closest command name, if the typo is small enough to be one. */
export function didYouMean(cmd: string): string | undefined {
  const hit = closest(cmd, [...Object.keys(COMMANDS), ...Object.keys(ALIASES)]);
  return hit ? canonical(hit) : undefined;
}

export function unknownFlag(name: string, known: string[]): string {
  const guess = closest(name, known);
  return `unknown option --${name}${guess ? `; did you mean --${guess}?` : ''}`;
}

export function commandHelp(cmd: string): string {
  const c = COMMANDS[cmd];
  return `${c.summary}\n\nUsage: ${c.usage}\n\n${c.details}\n`;
}

export function mainHelp(version: string, color = false): string {
  const p = paint(color);
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = Object.entries(COMMANDS).map(([k, c]) => `  ${p.bold(k.padEnd(width))}  ${c.summary}`);
  return `safectx ${version}: version-accurate docs and a supply-chain verdict for coding agents.

Usage: safectx <command> [options]

Commands:
${lines.join('\n')}

  safectx <command> --help   details for one command
  safectx --version          print the version

Quick start (Claude Code):  npx -y safectx init claude
Quick start (Cursor):       npx -y safectx init cursor

${EXIT_CODES}
`;
}

/** The message for a command we do not know. */
export function unknownCommand(cmd: string): string {
  const guess = didYouMean(cmd);
  return `safectx: unknown command "${cmd}".${guess ? ` Did you mean "safectx ${guess}"?` : ''}\nRun "safectx --help" for the list of commands.`;
}
