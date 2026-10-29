/**
 * GitHub Actions references in workflow files (.github/workflows/*.yml) and
 * composite actions (action.yml): every `uses: owner/repo[/path]@ref` line.
 * Line-based on purpose, like the lockfile readers: no YAML dependency.
 * Local actions (./path) and Docker images (docker://) are not GitHub actions.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ActionUse {
  owner: string;
  repo: string;
  /** Sub-directory or reusable workflow inside the repo, e.g. "init" or ".github/workflows/ci.yml". */
  path?: string;
  ref: string;
  /** The version the author wrote in a trailing comment ("# v4.2.1"), if any. */
  comment?: string;
  line: number;
  file: string;
}

export const actionName = (u: Pick<ActionUse, 'owner' | 'repo'>) => `${u.owner}/${u.repo}`;
export const useKey = (u: ActionUse) => `${actionName(u)}${u.path ? `/${u.path}` : ''}@${u.ref}`;

const WORKFLOW = /(^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/i;
const ACTION = /(^|[\\/])action\.ya?ml$/i;

export function isWorkflowFile(file: string): boolean {
  return (WORKFLOW.test(file) || ACTION.test(file)) && !/node_modules/.test(file);
}

const USES = /^\s*(?:-\s+)?uses\s*:\s*(["']?)([^"'\s#]+)\1\s*(?:#\s*(.*))?$/;

export function parseUses(content: string, file = ''): ActionUse[] {
  const out: ActionUse[] = [];
  content.split(/\r?\n/).forEach((text, i) => {
    const m = text.match(USES);
    if (!m) return;
    const ref = m[2];
    if (ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('docker://')) return;
    const at = ref.lastIndexOf('@');
    if (at <= 0) return;
    const [owner, repo, ...rest] = ref.slice(0, at).split('/');
    if (!owner || !repo || /[${}]/.test(ref)) return;
    const version = m[3]?.match(/\bv?\d+(?:\.\d+){0,2}\b/)?.[0];
    out.push({ owner, repo, path: rest.length ? rest.join('/') : undefined, ref: ref.slice(at + 1), comment: version, line: i + 1, file });
  });
  return out;
}

/** `uses:` lines that are new or point at a different ref than before the write. */
export function changedUses(newContent: string, oldContent: string | undefined, file = ''): ActionUse[] {
  const before = new Set(parseUses(oldContent ?? '', file).map(useKey));
  const seen = new Set<string>();
  return parseUses(newContent, file).filter((u) => {
    const k = useKey(u);
    if (before.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The workflow files behind a path: the file itself, the files of a
 * .github/workflows directory, or, for a project root, its .github/workflows
 * plus a root action.yml.
 */
export function workflowFiles(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return isWorkflowFile(target) ? [target] : [];
  const ymls = (dir: string) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).map((f) => path.join(dir, f)) : [];
  if (/[\\/]\.github[\\/]workflows[\\/]?$/i.test(path.resolve(target) + path.sep)) return ymls(target);
  const out = ymls(path.join(target, '.github', 'workflows'));
  for (const f of ['action.yml', 'action.yaml']) if (fs.existsSync(path.join(target, f))) out.push(path.join(target, f));
  return out;
}
