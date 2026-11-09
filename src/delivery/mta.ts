// The outbound MTA: groups the recipients by domain, finds each domain's MX and talks SMTP with it.
// Each recipient ends up delivered, deferred (4xx: try again later) or bounced (5xx: give up).
import type { Resolver } from 'node:dns/promises';
import { mxRoute } from './mx.ts';
import { sendMail } from '../smtp/client.ts';

export type Outcome = { recipient: string; status: 'delivered' | 'deferred' | 'bounced'; via?: string; code: number | null; detail: string };
export type MtaOptions = {
  resolver: Resolver;
  portOf: (exchange: string) => number | undefined; // locally everything is 127.0.0.1: the MX name becomes a port
  heloName?: string;
  random?: () => number;
};

export async function deliver(envelope: { from: string; to: string[] }, data: string, opts: MtaOptions): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const [domain, recipients] of groupByDomain(envelope.to)) {
    outcomes.push(...(await deliverToDomain(domain, recipients, envelope.from, data, opts)));
  }
  return outcomes;
}

// One domain, one SMTP transaction: try its MX hosts in order of preference until one gives a final answer
async function deliverToDomain(domain: string, recipients: string[], from: string, data: string, opts: MtaOptions): Promise<Outcome[]> {
  const all = (status: Outcome['status'], code: number | null, detail: string, via?: string): Outcome[] =>
    recipients.map((recipient) => ({ recipient, status, via, code, detail }));

  const route = await mxRoute(domain, opts.resolver, opts.random);
  if (!route.ok) return all(route.temporary ? 'deferred' : 'bounced', null, route.reason);

  let lastError = 'no MX answered';
  for (const { exchange } of route.hosts) {
    const port = opts.portOf(exchange);
    if (port === undefined) {
      lastError = `${exchange}: no address`;
      continue;
    }
    const r = await sendMail({ port, heloName: opts.heloName, from, to: recipients, data });
    // The MX answered about each recipient: that is the final word for this domain
    if (r.ok || r.stage === 'rcpt') {
      const delivered: Outcome[] = r.ok
        ? r.accepted.map((recipient) => ({ recipient, status: 'delivered', via: exchange, code: 250, detail: r.queuedId ?? '' }))
        : [];
      const refused: Outcome[] = r.rejected.map((x) => ({
        recipient: x.address, status: x.code >= 500 ? 'bounced' : 'deferred', via: exchange, code: x.code, detail: x.text,
      }));
      return [...delivered, ...refused];
    }
    if (r.permanent) return all('bounced', r.code, r.text, exchange); // a 5xx: no other MX will take it either
    lastError = `${exchange}: ${r.code ?? r.stage} ${r.text}`; // a 4xx or a connection error: try the next MX
  }
  return all('deferred', null, lastError);
}

function groupByDomain(addresses: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const address of addresses) {
    const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
    groups.set(domain, [...(groups.get(domain) ?? []), address]);
  }
  return groups;
}
