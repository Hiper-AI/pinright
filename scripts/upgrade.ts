/** npx tsx scripts/upgrade.ts <ecosystem> <name> <from> [to] ["<query>"]: prints what upgrade-guide returns. */
import { parseEcosystem } from '../src/ecosystems.js';
import { upgradeGuide } from '../src/upgrade/index.js';

const [eco, name, from, to, query] = process.argv.slice(2);
const t0 = Date.now();
const r = await upgradeGuide({ ecosystem: parseEcosystem(eco)!, name, from, to: to || undefined, query });
console.log(r.text);
console.error(`\n[${r.text.length} chars, ${Date.now() - t0} ms]`);
