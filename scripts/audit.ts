/** npx tsx scripts/audit.ts <lockfile or manifest>: prints the whole-tree audit. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { parseFile } from '../src/tree/lockfiles.js';
import { auditTree, formatTreeAudit } from '../src/tree/audit.js';

const file = process.argv[2];
const dir = dirname(file);
const siblings: Record<string, string> = {};
for (const s of ['package.json', 'pyproject.toml', 'Cargo.toml']) if (existsSync(join(dir, s)) && basename(file) !== s) siblings[s] = readFileSync(join(dir, s), 'utf8');
const audit = await auditTree(parseFile(file, readFileSync(file, 'utf8'), siblings));
console.log(formatTreeAudit(audit));
if (process.argv.includes('--json')) console.log(JSON.stringify(audit, null, 2));
