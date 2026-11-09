// The whole path: MUA → MSA (authenticated submission) → MTA (MX lookup) → destination MX → mailbox.
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import { startDns } from '../src/testing/fake-dns.ts';
import { makeResolver } from '../src/delivery/mx.ts';
import { startSmtpServer } from '../src/smtp/server.ts';
import { sendMail } from '../src/smtp/client.ts';
import { buildMessage, envelopeOf } from '../src/mime/message.ts';
import { deliver, type Outcome } from '../src/delivery/mta.ts';
import { first, parseMessage } from '../src/mime/parse.ts';
import { seeded } from '../src/testing/random.ts';
import { explainSmtp, note, show } from './lib/explain.ts';

const now = () => new Date('2026-11-04T12:00:00Z');
const dns = await startDns({
  'acme.test': { mx: [{ priority: 10, exchange: 'mx.acme.test' }] },
  'shop.test': { mx: [{ priority: 10, exchange: 'mx.shop.test' }] },
});
// MSA: like a provider's port 587 (e.g. username "resend" and the API key as the password)
const msa = await startSmtpServer({ hostname: 'smtp.provider.test', auth: { resend: 're_lab_123' }, now });
const acme = await startSmtpServer({ hostname: 'mx.acme.test', domains: ['acme.test'], mailboxes: ['ana@acme.test'], now });
const shop = await startSmtpServer({ hostname: 'mx.shop.test', domains: ['shop.test'], greylist: true, now });
const ports: Record<string, number> = { 'mx.acme.test': acme.port, 'mx.shop.test': shop.port };

note(
  'The whole story: the Shop app writes a letter to Ana, with a copy to sales@shop.test',
  '   and a hidden copy (Bcc) to Carlos. The letter goes through three places:',
  '   1) the app takes the letter to the POST OFFICE (the MSA), showing its badge;',
  '   2) the post office finds out which building receives letters for each neighborhood and takes it there (the MTA);',
  '   3) the doorman of each building (the MX) puts the letter in the mailbox of whoever lives there.',
  '',
);

// 1. MUA: the app builds the message and submits it to the MSA, authenticated
const input = {
  from: 'Shop <orders@shop.test>', to: ['Ana <ana@acme.test>'], cc: ['sales@shop.test'], bcc: ['carlos@acme.test'],
  subject: 'Order 123 confirmed', text: 'Hi Ana!', date: now(), random: seeded(5),
};
const env = { from: 'bounces@shop.test', to: envelopeOf(input).to }; // return address separate from the From
const sub = await sendMail({ port: msa.port, auth: { user: 'resend', pass: 're_lab_123' }, heloName: 'app.shop.test', ...env, data: buildMessage(input) });
show(
  `1. submission (MUA → MSA): ${sub.ok ? `accepted, queue ${sub.queuedId}` : `${sub.code} ${sub.text}`}`,
  'the app showed its badge (username "resend" and the API key as the password), and the post office took the letter as number Q0001',
);

// 2. MTA: takes it from the MSA queue and delivers to each domain
const queued = msa.inbox[0];
const outcomes = await deliver({ from: queued.envelope.mailFrom, to: queued.envelope.rcptTo }, queued.raw, {
  resolver: makeResolver(dns.server), portOf: (h) => ports[h], heloName: 'smtp.provider.test',
});
// The reason comes from the doorman's real reply (code + text), explained by the same explainSmtp as the conversation
const explainOutcome = (o: Outcome): string => {
  if (o.status === 'delivered') return `it arrived! the doorman at ${o.via} put the letter in the mailbox`;
  const doorman = o.code ? explainSmtp('S', `${o.code} ${o.detail}`) : o.detail;
  if (o.status === 'bounced') return `it came back · ${doorman} · this becomes a return notice (bounce) to ${queued.envelope.mailFrom}`;
  return `saved for later · ${doorman} · the letter waits in the queue and the mail carrier tries again`;
};
console.log('2. delivery (MTA → MX):');
for (const o of outcomes) show(`   ${o.recipient.padEnd(18)} ${o.status.padEnd(9)} ${o.code ?? '-'} ${o.via ?? ''}`, explainOutcome(o), '      ');

// 3. What reached Ana's mailbox: two Received (one per stop) and the Return-Path written on final delivery
const mail = parseMessage(acme.inbox[0].raw);
console.log('3. in Ana\'s mailbox:');
show(
  `   Return-Path: ${first(mail.headers, 'return-path')}`,
  'the RETURN address from the envelope, written down on delivery: if something goes wrong, the notice goes to bounces@, not to orders@',
  '      ',
);
const received = mail.headers.get('received') ?? [];
received.forEach((r, i) => {
  const who = /from (\S+) by (\S+)/.exec(r);
  const last = i === received.length - 1;
  const when = i === 0 ? 'NEWEST stamp (on top)' : last ? 'OLDEST stamp (at the bottom)' : 'middle stamp';
  const trip = last ? '. Reading from the bottom up, you can follow the letter\'s trip' : '';
  show(`   Received: ${r}`, `${when}: ${who?.[1]} handed it to ${who?.[2]}${trip}`, '      ');
});
show(
  `   From: ${mail.from} · To: ${mail.to} · Cc: ${first(mail.headers, 'cc')}`,
  'what Ana SEES. Carlos (Bcc) doesn\'t show up anywhere: he was only on the envelope',
  '      ',
);
await Promise.all([dns.close(), msa.close(), acme.close(), shop.close()]);
