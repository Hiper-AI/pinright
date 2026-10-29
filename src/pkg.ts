/**
 * Name and version come from package.json at runtime (dist/../package.json once
 * installed), so a release bumps one file and the CLI, the MCP server info, the
 * User-Agent and every client config `init` writes follow. Renaming the package
 * is a change to package.json (`name`, `bin`, `mcpName`), not to this code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackage(): { name?: unknown; version?: unknown; mcpName?: unknown } {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const pkg = readPackage();
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

export const PKG_VERSION = str(pkg.version, '0.0.0');
/** The npm package: also the command, the server key in client configs, and the marker of our hook entries. */
export const PKG_NAME = str(pkg.name, 'safectx');
/** The key of our server in client configs and the name of files we own (`@scope/x` -> `x`). */
export const SERVER_KEY = PKG_NAME.replace(/^@[^/]+\//, '');
/** The MCP Registry name (`io.github.<org login>/<name>`, case-sensitive); npm verification compares it with `mcpName`. */
export const MCP_NAME = str(pkg.mcpName, `io.github.Hiper-AI/${PKG_NAME}`);

/** How a client launches the published package: `npx -y <name>`, plus a subcommand such as `hook claude`. */
export function npxLauncher(extra: string[] = []): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', PKG_NAME, ...extra] };
}
