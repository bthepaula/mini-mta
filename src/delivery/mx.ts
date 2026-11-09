// Where to deliver an email for @domain? The rule from RFC 5321 section 5.1, plus the null MX from RFC 7505.
import { Resolver } from 'node:dns/promises';

export type MxHost = { exchange: string; priority: number };
export type MxRoute =
  | { ok: true; domain: string; implicit: boolean; hosts: MxHost[] }
  | { ok: false; domain: string; reason: 'domain_not_found' | 'null_mx' | 'no_mail_host' | 'dns_error'; temporary: boolean };

// A Node Resolver pointed at our fake DNS (in production: the system resolver)
export function makeResolver(server: string): Resolver {
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([server]);
  return resolver;
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

export async function mxRoute(domain: string, resolver: Resolver, random: () => number = Math.random): Promise<MxRoute> {
  let records: MxHost[];
  try {
    records = await resolver.resolveMx(domain);
  } catch (e) {
    if (code(e) === 'ENOTFOUND') return { ok: false, domain, reason: 'domain_not_found', temporary: false }; // NXDOMAIN
    if (code(e) !== 'ENODATA') return { ok: false, domain, reason: 'dns_error', temporary: true }; // timeout, SERVFAIL...
    records = []; // the domain exists, but has no MX
  }
  // Null MX (RFC 7505): a single MX with preference 0 and target "." = "this domain doesn't receive email"
  if (records.length === 1 && records[0].priority === 0 && (records[0].exchange === '' || records[0].exchange === '.')) {
    return { ok: false, domain, reason: 'null_mx', temporary: false };
  }
  if (!records.length) {
    // Implicit MX: with no MX, the domain itself is the server, if it has an address (A/AAAA)
    try {
      await resolver.resolve4(domain);
      return { ok: true, domain, implicit: true, hosts: [{ exchange: domain, priority: 0 }] };
    } catch {
      return { ok: false, domain, reason: 'no_mail_host', temporary: false };
    }
  }
  // Lower number = more preferred. Ties are shuffled to spread the load across the servers.
  const byPriority = new Map<number, MxHost[]>();
  for (const r of records) byPriority.set(r.priority, [...(byPriority.get(r.priority) ?? []), r]);
  const hosts = [...byPriority.keys()].sort((a, b) => a - b).flatMap((p) => shuffle(byPriority.get(p)!, random));
  return { ok: true, domain, implicit: false, hosts };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
