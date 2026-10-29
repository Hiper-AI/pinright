/**
 * What an agent is about to add: dependency intents extracted from a shell
 * command (npm install, pip install, cargo add, go get, npx...) or from the new
 * content of a manifest it is writing. Only additions and version changes count,
 * so editing an old project does not re-litigate dependencies it already had.
 *
 * The pieces: shell.ts reads a command line, command.ts reads what each command
 * installs, writes.ts reads what a write changes, spec.ts reads a package spec.
 */
import { parseShell } from './shell.js';

export { type DepIntent, splitNpmSpec, splitPySpec } from './spec.js';
export { fromCommand, composerIntents } from './command.js';
export { fromFileWrite, isGuardedFile, isWatchedFile } from './writes.js';

/** Split a command line into simple commands and their words, honoring quotes. */
export function splitCommands(cmd: string): string[][] {
  return parseShell(cmd).commands.map((c) => c.words).filter((w) => w.length);
}
