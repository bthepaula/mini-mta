// Where does an email for @domain go? Asks the (fake, local) DNS and applies the MX rules.
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import { startDns } from '../src/testing/fake-dns.ts';
import { makeResolver, mxRoute, type MxRoute } from '../src/delivery/mx.ts';
import { seeded } from '../src/testing/random.ts';
import { note, show } from './lib/explain.ts';

const dns = await startDns({
  'acme.test': { mx: [{ priority: 20, exchange: 'mx2.acme.test' }, { priority: 10, exchange: 'mx1.acme.test' }] },
  'shop.test': { mx: [{ priority: 10, exchange: 'a.mx.shop.test' }, { priority: 10, exchange: 'b.mx.shop.test' }] },
  // like Resend inbound: a subdomain only for receiving, with the provider's MX
  'inbound.acme.test': { mx: [{ priority: 10, exchange: 'inbound-smtp.provider.test' }] },
  'small.test': { a: ['127.0.0.1'] },
  'no-mail.test': { mx: [{ priority: 0, exchange: '.' }] },
});
const resolver = makeResolver(dns.server);
const random = seeded(3);

function explainRoute(route: MxRoute): string {
  if (!route.ok) {
    switch (route.reason) {
      case 'null_mx':
        return 'the phone book says: "this neighborhood does NOT receive letters" (the MX "."). The mail carrier gives up right away, instead of trying for days';
      case 'domain_not_found': return 'this neighborhood isn\'t even in the phone book (NXDOMAIN). Trying again won\'t help';
      case 'no_mail_host': return 'the neighborhood exists, but no building there receives letters';
      case 'dns_error': return 'the phone book didn\'t answer right now. Try again later';
    }
  }
  if (route.implicit) {
    return 'there is no mail building in the phone book, so the mail carrier goes straight to the neighborhood\'s own address (implicit MX)';
  }
  const [a, b] = route.hosts;
  if (!b) {
    const extra = route.domain.startsWith('inbound.') ? ' (a "receive-only building" run by another provider)' : '';
    return `only one building receives the letters here: go straight to ${a.exchange}` + extra;
  }
  if (a.priority === b.priority) {
    return `a tie at ${a.priority}: both are the same, so a coin toss picks who goes first (that way the work is shared)`;
  }
  return `try ${a.priority} first; if it doesn't answer, go to ${b.priority}. The SMALLER number goes first, like a ticket in a line`;
}

note(
  'The story: the mail carrier knows the neighborhood\'s name (the domain, after the @), but not which BUILDING',
  '   receives its letters. So he looks it up in the internet phone book (DNS), which answers with',
  '   MX records: a "ticket number" for the line and the name of the building.',
  '',
);
for (const domain of ['acme.test', 'shop.test', 'inbound.acme.test', 'small.test', 'no-mail.test', 'does-not-exist.test']) {
  const route = await mxRoute(domain, resolver, random);
  const desc = route.ok
    ? route.hosts.map((h) => `${h.priority} ${h.exchange}`).join(' → ') + (route.implicit ? '  (implicit MX)' : '')
    : `no delivery: ${route.reason}${route.temporary ? ' (temporary)' : ' (permanent)'}`;
  show(`${domain.padEnd(20)} ${desc}`, explainRoute(route));
}
show(
  `\nDNS queries: ${dns.queries.length} · ${dns.queries.join(' · ')}`,
  'how many questions we asked the phone book. small.test needed TWO: the MX (there was none) and then the A (the neighborhood\'s address)',
);
await dns.close();
