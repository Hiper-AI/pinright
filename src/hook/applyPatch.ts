/**
 * Codex writes files with `apply_patch`, whose hook input carries the patch
 * text instead of a path and content:
 *
 *   *** Begin Patch
 *   *** Add File: requirements.txt
 *   +requests==2.32.3
 *   *** Update File: package.json
 *   @@
 *    "dependencies": {
 *   -  "zod": "3.22.0"
 *   +  "zod": "3.25.76"
 *   *** End Patch
 *
 * Each file becomes the tool input the other agents send (`file_path` with
 * `content`, or with `edits`), so the same file-write checks apply.
 */

export interface PatchedFile {
  file_path: string;
  content?: string;
  edits?: { old_string: string; new_string: string }[];
}

/** The patch text inside an apply_patch command (a string, or argv such as ["apply_patch", "<patch>"]). */
export function patchText(command: unknown): string | undefined {
  const text = Array.isArray(command) ? command.filter((c) => typeof c === 'string').join('\n') : command;
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('*** Begin Patch');
  if (start < 0) return undefined;
  const end = text.indexOf('*** End Patch', start);
  return text.slice(start, end < 0 ? undefined : end);
}

export function parseApplyPatch(command: unknown): PatchedFile[] {
  const text = patchText(command);
  if (!text) return [];
  const files: PatchedFile[] = [];
  let current: PatchedFile | undefined;
  let mode: 'add' | 'update' | 'skip' = 'skip';
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flushHunk = () => {
    if (current && mode === 'update' && (oldLines.length || newLines.length)) {
      current.edits!.push({ old_string: oldLines.join('\n'), new_string: newLines.join('\n') });
    }
    oldLines = [];
    newLines = [];
  };
  const flushFile = () => {
    if (current && mode === 'add') current.content = `${newLines.join('\n')}\n`;
    flushHunk();
    if (current && (current.content !== undefined || current.edits?.length)) files.push(current);
    current = undefined;
    mode = 'skip';
  };
  for (const line of text.trimEnd().split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flushFile();
      if (header[1] === 'Delete') continue;
      current = { file_path: header[2].trim(), ...(header[1] === 'Update' ? { edits: [] } : {}) };
      mode = header[1] === 'Add' ? 'add' : 'update';
      continue;
    }
    if (!current || line.startsWith('*** ')) continue; // Begin Patch, Move to, End of File
    if (mode === 'add') {
      if (line.startsWith('+')) newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      continue;
    }
    if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith('-')) oldLines.push(line.slice(1));
    else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(ctx);
      newLines.push(ctx);
    }
  }
  flushFile();
  return files;
}
