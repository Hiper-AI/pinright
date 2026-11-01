// Runtime smoke test for the express5-api task: imports app.js, listens on a
// free port and exercises each route. Prints one JSON line.
/* global console, process, fetch, AbortSignal */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const tests = [];
const t = (name, pass, got) => tests.push({ name, pass: Boolean(pass), ...(pass ? {} : { got: JSON.stringify(got)?.slice(0, 160) }) });

let server;
try {
  const mod = await import(pathToFileURL(resolve('app.js')).href);
  const app = mod.default ?? mod.app;
  server = app.listen(0);
  await new Promise((r, j) => {
    server.once('listening', r);
    server.once('error', j);
  });
} catch (e) {
  console.log(JSON.stringify({ tests: [{ name: 'import+listen', pass: false, error: String(e?.message ?? e).slice(0, 200) }] }));
  process.exit(0);
}
const base = `http://127.0.0.1:${server.address().port}`;
async function call(path, init = {}) {
  try {
    const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e?.name ?? e) };
  }
}

let r = await call('/files/a/b/c.txt');
t('wildcard', r.status === 200 && r.body?.path === 'a/b/c.txt', r);
r = await call('/docs/readme');
t('optional-ext-absent', r.status === 200 && r.body?.name === 'readme' && r.body?.ext === undefined, r);
r = await call('/docs/readme.md');
t('optional-ext-present', r.status === 200 && r.body?.name === 'readme' && r.body?.ext === 'md', r);
r = await call('/users/boom');
t('async-error-500', r.status === 500 && typeof r.body?.error === 'string', r);
r = await call('/users/7');
t('still-alive', r.status === 200, r);
r = await call('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ann' }) });
t('post-201', r.status === 201 && r.body?.id === 1 && r.body?.name === 'ann', r);

server.close();
console.log(JSON.stringify({ tests }));
process.exit(0);
