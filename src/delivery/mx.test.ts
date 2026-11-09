import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Resolver } from 'node:dns/promises';
import { startDns, type FakeDns } from '../testing/fake-dns.ts';
import { makeResolver, mxRoute } from './mx.ts';
import { seeded } from '../testing/random.ts';

let dns: FakeDns;
let resolver: Resolver;
beforeAll(async () => {
  dns = await startDns({
    'acme.test': { mx: [{ priority: 20, exchange: 'mx2.acme.test' }, { priority: 10, exchange: 'mx1.acme.test' }] },
    'shop.test': { mx: [{ priority: 10, exchange: 'a.mx.shop.test' }, { priority: 10, exchange: 'b.mx.shop.test' }] },
    'small.test': { a: ['127.0.0.1'] },
    'no-mail.test': { mx: [{ priority: 0, exchange: '.' }], a: ['127.0.0.1'] },
    'empty.test': {},
  });
  resolver = makeResolver(dns.server);
});
afterAll(() => dns.close());

describe('MX with Node\'s resolveMx against a fake DNS', () => {
  it('resolveMx returns the records as they came (unsorted)', async () => {
    // toMatchObject: newer Node versions (24+) add a "type: 'MX'" field to each record; only the order and these two fields matter here
    expect(await resolver.resolveMx('acme.test')).toMatchObject([
      { priority: 20, exchange: 'mx2.acme.test' },
      { priority: 10, exchange: 'mx1.acme.test' },
    ]);
  });

  it('the route tries the LOWEST preference number first', async () => {
    const r = await mxRoute('acme.test', resolver);
    expect(r.ok && r.hosts.map((h) => h.exchange)).toEqual(['mx1.acme.test', 'mx2.acme.test']);
  });

  it('a preference tie is shuffled (spreads the load)', async () => {
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const r = await mxRoute('shop.test', resolver, seeded(seed));
      if (r.ok) firsts.add(r.hosts[0].exchange);
    }
    expect([...firsts].sort()).toEqual(['a.mx.shop.test', 'b.mx.shop.test']);
  });

  it('no MX but with an address: implicit MX (the domain itself)', async () => {
    expect(await mxRoute('small.test', resolver)).toEqual({ ok: true, domain: 'small.test', implicit: true, hosts: [{ exchange: 'small.test', priority: 0 }] });
  });

  it('domain that does not exist (NXDOMAIN): permanent failure', async () => {
    expect(await mxRoute('does-not-exist.test', resolver)).toMatchObject({ ok: false, reason: 'domain_not_found', temporary: false });
  });

  it('null MX: the domain declares it does not receive email, even with an address', async () => {
    expect(await mxRoute('no-mail.test', resolver)).toMatchObject({ ok: false, reason: 'null_mx', temporary: false });
  });

  it('no MX and no address: nowhere to deliver', async () => {
    expect(await mxRoute('empty.test', resolver)).toMatchObject({ ok: false, reason: 'no_mail_host' });
  });
});
