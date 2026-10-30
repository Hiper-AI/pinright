/**
 * Reading a dependency file, workflow or .pinright.json from a project that may
 * not be trusted: a cloned repository, a pull request in CI. Such a repository
 * can ship `requirements.txt` as a symlink to ~/.ssh/id_rsa, /proc/self/environ
 * or /dev/zero; what pinright parses goes into tool output, SARIF and registry
 * queries, so the content would leak or the process would hang.
 *
 * - the file, after resolving links, must stay inside `root` (by default its
 *   own directory), unless the caller opts out with allowOutside;
 * - it must be a regular file (no FIFO, device or directory);
 * - it must be at most maxBytes.
 *
 * Errors name the file and the reason, never any of its content.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The largest real lockfiles are a few MB; this leaves room and still stops /dev/zero-like input. */
export const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024;

export class ProjectFileError extends Error {
  constructor(
    public readonly file: string,
    reason: string,
  ) {
    super(`${file} not read: ${reason}`);
    this.name = 'ProjectFileError';
  }
}

function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ProjectFileOptions {
  /** The directory the file must resolve into. Default: the file's own directory. */
  root?: string;
  /** Follow links wherever they go (the file is the user's own, e.g. the one an agent is editing). */
  allowOutside?: boolean;
  maxBytes?: number;
}

export function readProjectFile(file: string, opts: ProjectFileOptions = {}): string {
  const maxBytes = opts.maxBytes ?? MAX_PROJECT_FILE_BYTES;
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (err) {
    throw new ProjectFileError(file, (err as NodeJS.ErrnoException).code ?? 'cannot be resolved');
  }
  if (!opts.allowOutside) {
    let root: string;
    try {
      root = fs.realpathSync(opts.root ?? path.dirname(path.resolve(file)));
    } catch {
      throw new ProjectFileError(file, 'its directory cannot be resolved');
    }
    if (!inside(root, real)) throw new ProjectFileError(file, `it links outside ${opts.root ?? path.dirname(path.resolve(file))}`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new ProjectFileError(file, 'not a regular file');
  if (st.size > maxBytes) throw new ProjectFileError(file, `larger than ${maxBytes} bytes`);
  // Bounded read: /proc-style files report size 0 and a file can grow after the stat.
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(maxBytes + 1, Math.max(st.size + 1, 64 * 1024)));
    let total = 0;
    for (;;) {
      if (total === buf.length) {
        if (total > maxBytes) throw new ProjectFileError(file, `larger than ${maxBytes} bytes`);
        return readRest(fd, buf, maxBytes, file);
      }
      const n = fs.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) return buf.subarray(0, total).toString('utf8');
      total += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The file outgrew its stat: keep reading in chunks up to the cap. */
function readRest(fd: number, head: Buffer, maxBytes: number, file: string): string {
  const chunks = [head];
  let total = head.length;
  const chunk = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks).toString('utf8');
    total += n;
    if (total > maxBytes) throw new ProjectFileError(file, `larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
}

/** readProjectFile, or undefined when the file is missing or refused. */
export function readProjectFileIfOk(file: string, opts?: ProjectFileOptions): string | undefined {
  try {
    return readProjectFile(file, opts);
  } catch {
    return undefined;
  }
}
