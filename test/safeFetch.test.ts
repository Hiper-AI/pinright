/**
 * The guard for URLs taken from package metadata: address classes, literal
 * IP encodings, internal names, names that resolve inward, redirects, and a
 * normal fetch. The end-to-end cases use a local server reached through a
 * fake name, so the request is pinned to the address the guard vetted;
 * nothing leaves the machine.
 */
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { llmsDocs } from '../src/docs/sources.js';
import { HttpError, isNotFound } from '../src/http.js';
import { githubRepo } from '../src/registry.js';
import { UnsafeUrlError, checkUrl, getUntrustedText, guardedLookup, isPublicAddress, type UrlPolicy } from '../src/safeFetch.js';

const publicResolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

afterEach(() => {
  vi.restoreAllMocks();
  publicResolve.mockClear();
});

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.100.100.200', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ])('refuses IPv4 %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    '::', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '::127.0.0.1', 'fd00:ec2::254', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1',
    '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '2001:db8::1', '2001::1', '2002:7f00:1::1', '100::1', '3fff::1',
  ])('refuses IPv6 %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'accepts %s',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );

  it('refuses anything that is not an address', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('getUntrustedText refuses before any request', () => {
  const refused = async (url: string, policy: UrlPolicy = { resolve: publicResolve }) => {
    const err = await getUntrustedText(url, { policy }).catch((e: unknown) => e);
    expect(err, url).toBeInstanceOf(UnsafeUrlError);
    return err as UnsafeUrlError;
  };

  it.each([
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://0/',
    'https://127.0.0.1./', 'https://169.254.169.254/latest/meta-data/', 'http://0xa9fea9fe/computeMetadata/v1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[fd00:ec2::254]/', 'https://[fe80::1]/',
    'https://[0:0:0:0:0:0:0:1]/', 'https://10.0.0.1/llms.txt', 'https://192.168.0.1/', 'https://100.100.100.200/',
  ])('literal address %s', async (url) => {
    await refused(url);
    expect(publicResolve).not.toHaveBeenCalled();
  });

  it.each([
    'https://localhost/', 'https://LOCALHOST./llms.txt', 'https://foo.localhost/', 'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata/', 'https://printer.local/', 'https://router.home.arpa/', 'https://intranet/',
  ])('internal name %s', async (url) => {
    await refused(url);
    expect(publicResolve).not.toHaveBeenCalled();
  });

  it.each(['ftp://docs.example.com/llms.txt', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'gopher://docs.example.com/'])(
    'scheme %s',
    async (url) => {
      await refused(url);
    },
  );

  it.each(['https://user:pass@docs.example.com/', 'https://user@docs.example.com/', 'https://:pass@docs.example.com/'])('credentials in %s', async (url) => {
    expect((await refused(url)).message).toMatch(/credentials/);
  });

  it.each(['https://docs.example.com:8443/', 'https://docs.example.com:22/', 'https://docs.example.com:80/', 'http://docs.example.com:6379/'])(
    'port in %s',
    async (url) => {
      await refused(url);
    },
  );

  it('treats :443 as the default port', () => {
    expect(() => checkUrl(new URL('https://docs.example.com:443/llms.txt'))).not.toThrow();
  });

  it('refuses plain http', () => {
    expect(() => checkUrl(new URL('http://docs.example.com/'))).toThrow(UnsafeUrlError);
  });

  it('upgrades an http link from metadata to https', async () => {
    const resolve = vi.fn(async () => [{ address: '10.9.9.9', family: 4 }]);
    const err = await refused('http://docs.example.com/llms.txt', { resolve });
    expect(err.url).toBe('https://docs.example.com/llms.txt');
  });

  it.each([
    [[{ address: '10.0.0.5', family: 4 }]],
    [[{ address: '169.254.169.254', family: 4 }]],
    [[{ address: '::1', family: 6 }]],
    [[{ address: 'fd12:3456::1', family: 6 }]],
    [[{ address: '::ffff:192.168.1.1', family: 6 }]],
    // One bad address is enough: the socket may pick any of them.
    [[{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]],
  ])('a name that resolves to %j', async (addrs) => {
    await refused('https://evil.example.com/llms.txt', { resolve: async () => addrs });
  });

  it('checks names with dns.lookup by default', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    const err = await getUntrustedText('https://rebind.example.com/llms.txt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(lookup).toHaveBeenCalledWith('rebind.example.com', expect.objectContaining({ all: true }));
  });

  it('still refuses through an environment proxy', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:3128');
    vi.stubEnv('NO_PROXY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await refused('https://169.254.169.254/');
      await refused('https://evil.example.com/', { resolve: async () => [{ address: '10.0.0.1', family: 4 }] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('guardedLookup', () => {
  const call = (lookup: LookupFunction, options: dns.LookupOptions) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup('docs.example.com', options, (err, address, family) => resolve({ err, address, family })),
    );
  const url = new URL('https://docs.example.com/');

  it('hands the socket exactly the vetted addresses, resolving once', async () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }];
    const resolve = vi.fn(async () => addrs);
    const lookup = guardedLookup(url, { resolve });
    expect(await call(lookup, { all: true })).toEqual({ err: null, address: addrs, family: undefined });
    expect(await call(lookup, { family: 6 })).toEqual({ err: null, address: '2606:2800:220:1::1', family: 6 });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('fails the connection when the answer points inward', async () => {
    const lookup = guardedLookup(url, { resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
    const out = await call(lookup, { all: true });
    expect(out.err).toBeInstanceOf(UnsafeUrlError);
  });
});

describe('getUntrustedText against a local server', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  // Only the fake public name maps to the test server; anything else is "internal".
  const policy: UrlPolicy = {
    allowHttp: true,
    isAllowedAddress: (ip) => ip === '127.0.0.1',
    resolve: async (h) => [{ address: h === 'docs.example.test' ? '127.0.0.1' : '10.0.0.1', family: 4 }],
  };
  const at = (p: string) => `http://docs.example.test:${port}${p}`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const redirect = (to: string, status = 302) => {
        res.statusCode = status;
        res.setHeader('location', to);
        res.end();
      };
      const m = req.url?.match(/^\/chain(\d)$/);
      if (m) return redirect(`/chain${Number(m[1]) + 1}`);
      switch (req.url) {
        case '/llms.txt':
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('# Example\n\n- [Guide](https://docs.example.test/guide.md): the guide\n');
          return;
        case '/moved':
          return redirect('/llms.txt', 307);
        case '/to-internal':
          return redirect(`http://inner.example.test:${port}/secret`);
        case '/to-metadata':
          return redirect('http://169.254.169.254/latest/meta-data/');
        case '/to-localhost':
          return redirect(`http://localhost:${port}/llms.txt`);
        case '/to-creds':
          return redirect(`http://u:p@docs.example.test:${port}/llms.txt`);
        case '/loop':
          return redirect('/loop');
        case '/big':
          res.end(Buffer.alloc(5000, 'a'));
          return;
        case '/missing':
          res.statusCode = 404;
          res.end();
          return;
        default:
          res.statusCode = 500;
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches a public llms.txt, connecting to the vetted address', async () => {
    const text = await getUntrustedText(at('/llms.txt'), { policy });
    expect(text).toContain('[Guide]');
    expect(hits.at(-1)).toBe(`docs.example.test:${port}/llms.txt`);
  });

  it('follows a redirect to the same public host', async () => {
    expect(await getUntrustedText(at('/moved'), { policy })).toContain('# Example');
  });

  it.each(['/to-internal', '/to-metadata', '/to-localhost', '/to-creds'])('refuses the hop after %s', async (p) => {
    const before = hits.length;
    await expect(getUntrustedText(at(p), { policy })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(hits.length - before).toBe(1); // the redirect target was never requested
  });

  it('stops a redirect loop', async () => {
    await expect(getUntrustedText(at('/loop'), { policy })).rejects.toThrow(/redirect loop/);
  });

  it('stops after three redirects', async () => {
    await expect(getUntrustedText(at('/chain1'), { policy })).rejects.toThrow(/more than 3 redirects/);
  });

  it('keeps the size cap', async () => {
    await expect(getUntrustedText(at('/big'), { policy, maxBytes: 1000 })).rejects.toThrow(/larger than 1000 bytes/);
    expect(await getUntrustedText(at('/big'), { policy, maxBytes: 10_000 })).toHaveLength(5000);
  });

  it('turns a 404 into an HttpError', async () => {
    const err = await getUntrustedText(at('/missing'), { policy }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isNotFound(err)).toBe(true);
  });
});

describe('call sites', () => {
  it('llmsDocs never requests a metadata address from a homepage', async () => {
    const saved = config.cacheDisabled;
    (config as { cacheDisabled: boolean }).cacheDisabled = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lookup = vi.spyOn(dns.promises, 'lookup');
    try {
      expect(await llmsDocs('http://169.254.169.254/latest/')).toBeUndefined();
      expect(await llmsDocs('http://2130706433/docs/')).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      (config as { cacheDisabled: boolean }).cacheDisabled = saved;
    }
  });

  it('githubRepo keeps GitHub names and drops path tricks', () => {
    expect(githubRepo('git+https://github.com/vercel/next.js.git')).toEqual({ owner: 'vercel', repo: 'next.js' });
    expect(githubRepo('https://github.com/../..')).toBeUndefined();
    expect(githubRepo('https://github.com/a/%2e%2e')).toBeUndefined();
    expect(githubRepo('https://github.com/owner/repo@evil')).toBeUndefined();
  });
});
