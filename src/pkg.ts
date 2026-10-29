/**
 * The version comes from package.json at runtime (dist/../package.json once
 * installed), so a release bumps one file and the CLI, the MCP server info
 * and the User-Agent follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const PKG_VERSION = readVersion();
