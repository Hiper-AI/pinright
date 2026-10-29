/**
 * Entry point of the safectx GitHub Action (bundled to action-dist/index.mjs,
 * run by the composite action.yml). Audits the path, writes SARIF for the
 * upload step, a job summary and annotations, and hands the exit code to the
 * last step as an output: it always exits 0 itself, so the SARIF is uploaded
 * even when the audit fails the build.
 *
 * Inputs arrive as SAFECTX_INPUT_* variables, set by action.yml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditInputError, auditExitCode, formatAuditRun, parseFailOn, runAudit, runToSarif, sarifRoot } from '../auditRun.js';
import { annotations, fenceCommands, summaryMarkdown } from '../sarif/summary.js';

const env = process.env;
const input = (name: string, fallback = '') => (env[`SAFECTX_INPUT_${name}`] ?? '').trim() || fallback;
const flag = (name: string, fallback: boolean) => {
  const v = input(name).toLowerCase();
  return v ? v === 'true' : fallback;
};

function setOutput(name: string, value: string | number) {
  const file = env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
  else console.log(`[safectx] output ${name}=${value}`);
}

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<number> {
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const target = path.resolve(workspace, input('PATH', '.'));
  const failOnRaw = input('FAIL_ON', 'high');
  const failOn = parseFailOn(failOnRaw);
  if (!failOn) {
    console.log(`::error title=safectx::fail-on must be low, moderate, high, critical or none (got "${failOnRaw}")`);
    return 2;
  }
  const configInput = input('CONFIG');
  let run;
  try {
    run = await runAudit({
      target,
      config: configInput ? path.resolve(workspace, configInput) : undefined,
      supplyChain: flag('SUPPLY_CHAIN', true),
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`::error title=safectx::${msg.replace(/\r?\n/g, ' ')}`);
    return err instanceof AuditInputError ? 2 : 3;
  }
  const code = auditExitCode(run, failOn);

  console.log('::group::safectx report');
  console.log(fenceCommands(formatAuditRun(run, 100), { actions: true }));
  console.log('::endgroup::');

  const log = runToSarif(run, { root: sarifRoot(target, workspace), toolVersion: version() });
  let sarifFile = '';
  if (flag('SARIF', true)) {
    sarifFile = path.join(env.RUNNER_TEMP ?? path.join(workspace, '.safectx'), 'safectx', 'results.sarif');
    fs.mkdirSync(path.dirname(sarifFile), { recursive: true });
    fs.writeFileSync(sarifFile, JSON.stringify(log));
  }
  if (flag('ANNOTATIONS', true)) for (const line of annotations(log)) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      summaryMarkdown(log, { exitCode: code, failOn, sarifFile: sarifFile ? path.basename(sarifFile) : undefined, uploaded: Boolean(sarifFile) && flag('UPLOAD', true) }),
    );
  }
  setOutput('sarif-file', sarifFile);
  setOutput('results', log.runs[0].results.length);
  return code;
}

main().then(
  (code) => {
    setOutput('exit-code', code);
    process.exit(0);
  },
  (err) => {
    console.log(`::error title=safectx::${(err as Error).message.replace(/\r?\n/g, ' ')}`);
    setOutput('exit-code', 3);
    process.exit(0);
  },
);
