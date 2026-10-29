/** npx tsx scripts/docs.ts <ecosystem> <name> <version> "<query>": prints what get-docs would return. */
import { getDocs } from '../src/docs/index.js';
import { parseEcosystem } from '../src/ecosystems.js';

const [eco, name, version, query] = process.argv.slice(2);
const t0 = Date.now();
const r = await getDocs({ ecosystem: parseEcosystem(eco)!, name, version, query });
console.log(r.text);
console.error(`\n[via ${r.via}, ${r.text.length} chars, ${r.sources.length} sources, ${Date.now() - t0} ms]`);
for (const s of r.sources) console.error(`  ${s.versionAccurate ? 'exact ' : 'site  '} ${s.label}`);
