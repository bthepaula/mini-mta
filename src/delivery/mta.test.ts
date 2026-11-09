import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { startDns, type FakeDns } from '../testing/fake-dns.ts';
import { makeResolver } from './mx.ts';
import { startSmtpServer, type SmtpServer } from '../smtp/server.ts';
import { deliver, type MtaOptions } from './mta.ts';

// Scenario: acme.test has two MX (the primary is down), shop.test does greylisting,
// small.test has no MX (implicit MX), no-mail.test publishes a null MX, down.test has an MX nobody answers.
let dns: FakeDns;
let mx2: SmtpServer, shopMx: SmtpServer, small: SmtpServer;
let opts: MtaOptions;
const data = 'From: Shop <orders@shop.test>\r\nSubject: hi\r\n\r\nHi!\r\n';

async function deadPort(): Promise<number> {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

beforeAll(async () => {
  dns = await startDns({
    'acme.test': { mx: [{ priority: 10, exchange: 'mx1.acme.test' }, { priority: 20, exchange: 'mx2.acme.test' }] },
    'shop.test': { mx: [{ priority: 10, exchange: 'mx.shop.test' }] },
    'small.test': { a: ['127.0.0.1'] },
    'no-mail.test': { mx: [{ priority: 0, exchange: '.' }] },
    'down.test': { mx: [{ priority: 10, exchange: 'mx.down.test' }] },
  });
  mx2 = await startSmtpServer({ hostname: 'mx2.acme.test', domains: ['acme.test'], mailboxes: ['ana@acme.test', 'bia@acme.test'] });
  shopMx = await startSmtpServer({ hostname: 'mx.shop.test', domains: ['shop.test'], greylist: true });
  small = await startSmtpServer({ hostname: 'small.test', domains: ['small.test'] });
  const ports: Record<string, number> = {
    'mx1.acme.test': await deadPort(), 'mx2.acme.test': mx2.port, 'mx.shop.test': shopMx.port,
    'small.test': small.port, 'mx.down.test': await deadPort(),
  };
  opts = { resolver: makeResolver(dns.server), portOf: (h) => ports[h], heloName: 'out.lab.test' };
});
afterAll(async () => { await Promise.all([dns.close(), mx2.close(), shopMx.close(), small.close()]); });

const one = async (to: string) => (await deliver({ from: 'bounces@lab.test', to: [to] }, data, opts))[0];

describe('MTA: delivery via MX', () => {
  it('primary is down: falls back to the priority 20 MX', async () => {
    expect(await one('ana@acme.test')).toMatchObject({ status: 'delivered', via: 'mx2.acme.test', code: 250 });
  });

  it('a missing mailbox becomes a bounce without affecting the other recipient of the same domain', async () => {
    const out = await deliver({ from: 'bounces@lab.test', to: ['bia@acme.test', 'carlos@acme.test'] }, data, opts);
    expect(out.map((o) => [o.recipient, o.status, o.code])).toEqual([['bia@acme.test', 'delivered', 250], ['carlos@acme.test', 'bounced', 550]]);
  });

  it('greylisting (451) becomes deferred: stays in the queue to try again later', async () => {
    expect(await one('sales@shop.test')).toMatchObject({ status: 'deferred', code: 451 });
  });

  it('implicit MX: delivers to the domain itself', async () => {
    expect(await one('owner@small.test')).toMatchObject({ status: 'delivered', via: 'small.test' });
  });

  it('null MX: immediate bounce, without opening a connection', async () => {
    expect(await one('x@no-mail.test')).toMatchObject({ status: 'bounced', code: null, detail: 'null_mx' });
  });

  it('domain does not exist: permanent bounce', async () => {
    expect(await one('x@does-not-exist.test')).toMatchObject({ status: 'bounced', detail: 'domain_not_found' });
  });

  it('no MX answers: deferred (not a bounce: it may be a temporary outage)', async () => {
    expect(await one('x@down.test')).toMatchObject({ status: 'deferred', code: null });
  });

  it('one SMTP transaction per domain, with all of its recipients', async () => {
    const before = mx2.inbox.length;
    await deliver({ from: 'bounces@lab.test', to: ['ana@acme.test', 'bia@acme.test', 'owner@small.test'] }, data, opts);
    expect(mx2.inbox.length - before).toBe(1);
    expect(mx2.inbox.at(-1)!.envelope.rcptTo).toEqual(['ana@acme.test', 'bia@acme.test']);
  });
});
