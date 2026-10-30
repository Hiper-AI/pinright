/**
 * Requests to URLs that come from third-party data: a package's homepage or
 * docs site, the pages its llms.txt lists, a link in a release body. Their
 * publisher picks the host, so the request must not reach loopback, private
 * networks or cloud metadata (pinright runs in CI and on developer machines).
 *
 * - https only (an http:// link from metadata is upgraded; a redirect to http
 *   is refused), default port, no credentials in the URL;
 * - literal IPs are checked after WHATWG parsing, which already normalises
 *   decimal, octal and hex forms ("http://2130706433/" is 127.0.0.1);
 * - names that only make sense inside a network (localhost, *.internal,
 *   single labels...) are refused before any lookup;
 * - every address a name resolves to must be public, and the check runs in
 *   the socket's own lookup, so the connection goes to the address that was
 *   checked: a DNS answer that changes between check and connect cannot
 *   point it inward (rebinding);
 * - redirects are followed by hand, at most MAX_REDIRECTS, each hop checked
 *   again; timeout and size cap cover the whole body.
 *
 * Behind a proxy (NODE_USE_ENV_PROXY=1 with HTTPS_PROXY) the proxy resolves
 * and connects, so the address cannot be pinned: the URL checks and a local
 * lookup still run, but a rebinding answer could slip past (see SECURITY.md).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';
import { HttpError, USER_AGENT } from './http.js';

export class UnsafeUrlError extends Error {
  constructor(
    public readonly url: string,
    reason: string,
  ) {
    super(`Refused ${url}: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 10_000_000;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

// ------------------------------------------------------------ addresses -----

// Not globally routable: this network, private, CGNAT (and Alibaba's metadata), loopback,
// link-local (cloud metadata), IETF/benchmark/documentation ranges, 6to4 relay, multicast, reserved.
const V4_BLOCKED: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 0, 2, 0, 24], [192, 88, 99, 0, 24], [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15], [198, 51, 100, 0, 24], [203, 0, 113, 0, 24], [224, 0, 0, 0, 4], [240, 0, 0, 0, 4],
];

function inPrefix(bytes: number[], base: number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 8) {
    const n = Math.min(8, bits - i);
    const mask = (0xff << (8 - n)) & 0xff;
    if ((bytes[i / 8] & mask) !== (base[i / 8] & mask)) return false;
  }
  return true;
}

function v4Public(b: number[]): boolean {
  return !V4_BLOCKED.some(([a, c, d, e, bits]) => inPrefix(b, [a, c, d, e], bits));
}

/** 16 bytes of an IPv6 address (with or without brackets, zone or dotted tail). */
export function ipv6Bytes(ip: string): number[] | undefined {
  let s = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(s)) return undefined;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const split = s.split('::');
  const left = split[0] ? split[0].split(':') : [];
  const right = split.length > 1 && split[1] ? split[1].split(':') : [];
  const fill = split.length > 1 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((h) => Number.parseInt(h, 16));
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

function v6Public(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Public(b.slice(12));
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4Public(b.slice(12));
  // Only global unicast (2000::/3). That leaves out ::, ::1, IPv4-compatible, ULA fc00::/7
  // (AWS metadata is fd00:ec2::254), link-local fe80::/10, site-local fec0::/10, multicast.
  if ((b[0] & 0xe0) !== 0x20) return false;
  if (inPrefix(b, [0x20, 0x01, 0, 0], 23)) return false; // IETF protocol assignments, Teredo
  if (inPrefix(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (inPrefix(b, [0x20, 0x02], 16)) return false; // 6to4 (deprecated, embeds any IPv4)
  if (inPrefix(b, [0x3f, 0xff, 0], 20)) return false; // documentation (RFC 9637)
  return true;
}

/** True for an address a request from pinright may connect to. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) return v4Public(bare.split('.').map(Number));
  const b = ipv6Bytes(bare);
  return b ? v6Public(b) : false;
}

// ---------------------------------------------------------------- names -----

const INTERNAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;

export interface UrlPolicy {
  /** Tests only: plain http to a local server. */
  allowHttp?: boolean;
  /** Tests only: which addresses count as public. */
  isAllowedAddress?: (ip: string) => boolean;
  /** Resolves a name to all its addresses; dns.lookup by default. */
  resolve?: (hostname: string) => Promise<dns.LookupAddress[]>;
}

const defaultResolve = (hostname: string) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Throws UnsafeUrlError unless the URL itself is acceptable (no lookup yet). */
export function checkUrl(url: URL, policy: UrlPolicy = {}): void {
  const refuse = (why: string) => {
    throw new UnsafeUrlError(url.href, why);
  };
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) refuse(`${url.protocol} is not allowed, only https`);
  if (url.username || url.password) refuse('credentials in the URL');
  if (url.port && !policy.allowHttp) refuse(`port ${url.port} is not allowed`);
  const host = url.hostname.replace(/\.+$/, '').toLowerCase();
  if (!host) refuse('no host');
  const allowed = policy.isAllowedAddress ?? isPublicAddress;
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
    if (!allowed(host)) refuse(`${host} is not a public address`);
    return;
  }
  if (!host.includes('.') || INTERNAL_NAME.test(host)) refuse(`${host} is an internal name`);
}

async function vetAddresses(url: URL, policy: UrlPolicy): Promise<dns.LookupAddress[]> {
  const host = url.hostname.replace(/\.+$/, '');
  const addrs = await (policy.resolve ?? defaultResolve)(host);
  if (!addrs.length) throw new UnsafeUrlError(url.href, `${host} did not resolve`);
  const allowed = policy.isAllowedAddress ?? isPublicAddress;
  const bad = addrs.find((a) => !allowed(a.address));
  if (bad) throw new UnsafeUrlError(url.href, `${host} resolves to ${bad.address}, not a public address`);
  return addrs;
}

/**
 * The socket's lookup: resolve, refuse if any address is not public, and hand
 * the socket exactly the addresses that passed. Exported for tests.
 */
export function guardedLookup(url: URL, policy: UrlPolicy): net.LookupFunction {
  return (_hostname, options, callback) => {
    vetAddresses(url, policy).then(
      (addrs) => {
        if (options.all) return callback(null, addrs);
        const pick = addrs.find((a) => !options.family || a.family === options.family) ?? addrs[0];
        callback(null, pick.address, pick.family);
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, ''),
    );
  };
}

// -------------------------------------------------------------- proxies -----

function viaEnvProxy(url: URL): boolean {
  if (process.env.NODE_USE_ENV_PROXY !== '1') return false;
  const proxy = url.protocol === 'https:' ? process.env.HTTPS_PROXY || process.env.https_proxy : process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return false;
  const host = url.hostname.toLowerCase();
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(/[,\s]+/).filter(Boolean);
  return !noProxy.some((e) => e === '*' || host === e.replace(/^\*?\./, '') || host.endsWith(`.${e.replace(/^\*?\./, '')}`));
}

// ------------------------------------------------------------- requests -----

interface Hop {
  status: number;
  location?: string;
  retryAfter?: number;
  body?: string;
}

const HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/plain, text/markdown;q=0.9, text/html;q=0.5, */*;q=0.1',
  'accept-encoding': 'identity',
};

function tooLarge(url: URL, maxBytes: number): Error {
  return new Error(`${url.href} is larger than ${maxBytes} bytes`);
}

const decode = (chunks: Buffer[]) => new TextDecoder('utf-8').decode(Buffer.concat(chunks));

/** One direct request, connected to the vetted address. */
function directHop(url: URL, policy: UrlPolicy, signal: AbortSignal, maxBytes: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, { method: 'GET', headers: HEADERS, agent: false, lookup: guardedLookup(url, policy), signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        const retry = Number.parseInt(String(res.headers['retry-after'] ?? ''), 10);
        return resolve({ status, location: res.headers.location, retryAfter: Number.isFinite(retry) ? retry : undefined });
      }
      if (Number.parseInt(res.headers['content-length'] ?? '', 10) > maxBytes) {
        res.destroy();
        return reject(tooLarge(url, maxBytes));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          reject(tooLarge(url, maxBytes));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status, body: decode(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** One request through the environment proxy: built-in fetch, redirects by hand. */
async function proxiedHop(url: URL, policy: UrlPolicy, signal: AbortSignal, maxBytes: number): Promise<Hop> {
  if (!net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) await vetAddresses(url, policy);
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual', signal });
  if (!res.ok) {
    await res.body?.cancel();
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    return { status: res.status, location: res.headers.get('location') ?? undefined, retryAfter: Number.isFinite(retry) ? retry : undefined };
  }
  if (Number.parseInt(res.headers.get('content-length') ?? '', 10) > maxBytes) throw tooLarge(url, maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) throw tooLarge(url, maxBytes);
    chunks.push(Buffer.from(chunk));
  }
  return { status: res.status, body: decode(chunks) };
}

/**
 * GET a third-party URL as text under the rules above. Non-2xx answers throw
 * HttpError like getText; refused URLs throw UnsafeUrlError.
 */
export async function getUntrustedText(raw: string, opts: { maxBytes?: number; policy?: UrlPolicy } = {}): Promise<string> {
  const policy = opts.policy ?? {};
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(raw, 'not a URL');
  }
  // Metadata still carries plain-http homepages; ask the same host over TLS instead.
  if (url.protocol === 'http:' && !policy.allowHttp && !url.port) url.protocol = 'https:';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const seen = new Set<string>();
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url, policy);
      if (seen.has(url.href)) throw new UnsafeUrlError(raw, 'redirect loop');
      seen.add(url.href);
      const r = await (viaEnvProxy(url) ? proxiedHop : directHop)(url, policy, controller.signal, maxBytes);
      if (REDIRECT.has(r.status) && r.location) {
        if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError(raw, `more than ${MAX_REDIRECTS} redirects`);
        url = new URL(r.location, url);
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, url.href, r.retryAfter);
      return r.body ?? '';
    }
  } finally {
    clearTimeout(timer);
  }
}
