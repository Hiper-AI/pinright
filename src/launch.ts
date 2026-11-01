/**
 * How an agent starts pinright: the bare binary of a global install, or `npx -y pinright`.
 * The hook runs before every agent tool call, and npx resolves the package on each one
 * (measured on Windows, Node 24, npm 11: about 0.9 s for `npx -y pinright hook claude`
 * with a global install present, against 0.16 s for `pinright hook claude`). `init`
 * writes the binary into the user's own files when a real global install is on PATH,
 * and npx into the project files a team shares.
 */
import fs from 'node:fs';
import path from 'node:path';
import { npxLauncher, PKG_NAME } from './pkg.js';

export interface GlobalInstall {
  /** The command found on PATH (pinright, pinright.cmd). */
  bin: string;
  /** The installed package's folder, whose package.json says it is pinright. */
  packageDir: string;
  version: string;
}

export type LauncherKind = 'global' | 'npx' | 'node' | 'other';

/** The package.json of `dir`, when it is this package with its bin. */
function ourPackage(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[PKG_NAME];
    return pkg.name === PKG_NAME && typeof bin === 'string' && typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** The package folder behind a bin: npm's Windows shims sit next to node_modules; elsewhere the bin links into the package. */
function packageBehind(bin: string, platform: NodeJS.Platform): string | undefined {
  const dir = path.dirname(bin);
  if (platform === 'win32') {
    const beside = path.join(dir, 'node_modules', PKG_NAME);
    if (ourPackage(beside)) return beside;
    // Other shims (pnpm, volta) name the script relative to their own folder: "%~dp0\..\x\node_modules\pinright\dist\cli.js".
    let text = '';
    try {
      text = fs.readFileSync(bin, 'utf8').slice(0, 4096);
    } catch {
      return undefined;
    }
    const m = /%~?dp0%?\\?([^"\r\n]*?node_modules[\\/]+(?:@[^\\/]+[\\/]+)?[^\\/"]+)[\\/]/i.exec(text);
    const found = m ? path.resolve(dir, m[1]) : undefined;
    return found && ourPackage(found) ? found : undefined;
  }
  let real: string;
  try {
    real = fs.realpathSync(bin);
  } catch {
    return undefined;
  }
  for (let d = path.dirname(real), i = 0; i < 6; i++, d = path.dirname(d)) {
    if (ourPackage(d)) return d;
    if (path.dirname(d) === d) break;
  }
  return undefined;
}

/**
 * A global install of pinright on PATH, verified by its package.json. Project bins
 * (node_modules/.bin) and npx's temporary cache (_npx) do not count: npm adds both to
 * PATH while `npx pinright init` runs, and neither outlives that command.
 */
export function findGlobalInstall(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): GlobalInstall | undefined {
  const pathVar = env.PATH ?? env.Path ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? [`${PKG_NAME}.cmd`, `${PKG_NAME}.exe`, PKG_NAME] : [PKG_NAME];
  for (const raw of pathVar.split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || /[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(dir) || /[\\/]_npx[\\/]/i.test(dir)) continue;
    for (const n of names) {
      const bin = path.join(dir, n);
      if (!fs.existsSync(bin)) continue;
      const packageDir = packageBehind(bin, platform);
      const version = packageDir && ourPackage(packageDir);
      if (packageDir && version) return { bin, packageDir, version };
    }
  }
  return undefined;
}

const major = (v: string) => Number.parseInt(v, 10);

/**
 * What `init` writes for one scope. Project files are shared with a team through the repository, so
 * they get the portable `npx -y pinright` unless --bin asks for the binary; the user's own files get
 * the binary when a global install of the same major is on PATH. --npx and --dev apply to both.
 * `why` is the reason init prints next to each file.
 */
export function chooseLauncher(o: { scope: 'project' | 'user'; dev?: string; npx?: boolean; bin?: boolean; version: string; global?: GlobalInstall }): {
  command: string;
  args: string[];
  kind: LauncherKind;
  why: string;
} {
  if (o.dev) return { command: 'node', args: [o.dev], kind: 'node', why: '--dev: this checkout' };
  const npx = (why: string) => ({ ...npxLauncher(), kind: 'npx' as const, why });
  if (o.npx) return npx('--npx');
  const g = o.global && major(o.global.version) === major(o.version) ? o.global : undefined;
  const bin = (why: string) => ({ command: PKG_NAME, args: [], kind: 'global' as const, why });
  if (o.scope === 'project') {
    if (o.bin && g) {
      return bin(
        `--bin: the global install ${g.version}, about 0.2 s per hook call instead of about 1 s through npx. ` +
          `Teammates who use these files without "npm i -g ${PKG_NAME}" get a hook that does not start, and their agent runs the tool unchecked`,
      );
    }
    return npx(`project files are shared through the repository, so they get the launcher that works on any machine; about 1 s per hook call. "--bin" writes the global binary instead`);
  }
  if (g) return bin(`your own file, and the global install ${g.version} is on PATH (${g.bin}): about 0.2 s per hook call`);
  return npx(
    o.global
      ? `the global install is ${o.global.version}, another major than ${o.version}; update it (npm i -g ${PKG_NAME}) and run init --user again for the faster hook`
      : `no global install on PATH; "npm i -g ${PKG_NAME}" and init --user again for about 0.2 s per hook call instead of about 1 s`,
  );
}

/** Which launcher a hook command line uses ("npx -y pinright hook claude", "pinright hook claude", "node .../dist/cli.js hook claude"). */
export function launcherOf(command: string): LauncherKind {
  if (/(^|[\s"'])npx(\.cmd)?["']?\s/.test(command)) return 'npx';
  if (/dist[\\/]+cli\.js/.test(command)) return 'node';
  if (new RegExp(`(^|[\\s"'\\\\/])${PKG_NAME}(\\.cmd)?["']?\\s+hook\\b`).test(command)) return 'global';
  return 'other';
}

/** The command line of our hook for `agent` in a client's hook file, or undefined. */
export function hookCommandIn(text: string, agent: string): string | undefined {
  const ours = new RegExp(`\\bhook\\s+${agent}\\b`);
  // Hook files are JSON: read each string literal unescaped, so a quoted path ("node \"C:/x/cli.js\" hook claude") stays whole.
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    let s: string;
    try {
      s = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    if (ours.test(s)) return s.trim();
  }
  return new RegExp(`[^"\\n]*\\bhook\\s+${agent}\\b[^"\\n]*`).exec(text)?.[0].trim();
}
