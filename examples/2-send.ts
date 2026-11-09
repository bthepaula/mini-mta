// Envelope × header in practice: the header says "To: Ana", but the envelope sends it to Ana, Bia (Bcc) and Zé.
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import { startSmtpServer } from '../src/smtp/server.ts';
import { sendMail } from '../src/smtp/client.ts';
import { CAST, note, show, showSmtp } from './lib/explain.ts';

const server = await startSmtpServer({ hostname: 'mx.acme.test', domains: ['acme.test'], mailboxes: ['ana@acme.test', 'bia@acme.test'] });
const data = [
  'From: Shop <orders@shop.test>',
  'To: Ana <ana@acme.test>',
  'Subject: Order 123 confirmed',
  '',
  'Hi Ana!',
].join('\r\n');

const result = await sendMail({
  port: server.port,
  heloName: 'smtp.shop.test',
  from: 'bounces@shop.test', // envelope: bounces come here, not to the From in the header
  to: ['ana@acme.test', 'bia@acme.test', 'ze@other.test'],
  data,
});
note(
  ...CAST(),
  'The story: INSIDE the letter it says "To: Ana". But on the ENVELOPE the mail carrier wrote three names:',
  '   Ana, Bia (a hidden copy, the Bcc) and Zé, who lives in ANOTHER building (other.test).',
  '',
);
for (const line of result.transcript) showSmtp(line);
console.log('');
if (result.ok) {
  show(
    `accepted: ${result.accepted.join(', ')}`,
    'both of them live in the acme.test building, so the doorman took the letter for them',
  );
  show(
    `rejected: ${result.rejected.map((r) => `${r.address} (${r.code})`).join(', ')}`,
    'Zé lives in another building, and this doorman only takes letters for people who live here. The letter still went on to the other two',
  );
}
const stored = server.inbox[0];
const header = (name: string) => stored.raw.split('\r\n').find((l) => l.startsWith(name + ':'));
console.log('');
show(
  `stored envelope: MAIL FROM ${stored.envelope.mailFrom} · RCPT TO ${stored.envelope.rcptTo.join(', ')}`,
  'what was written on the ENVELOPE, which is what the mail carrier reads to know where to deliver. Bia is here...',
);
show(
  `header seen:     ${header('From')} · ${header('To')}`,
  '...but she is not INSIDE the letter, which only talks about Ana. That is why nobody finds out about the hidden copy (Bcc)',
);
show(
  `added on delivery: ${header('Return-Path')}`,
  'if the letter can\'t be delivered, the notice goes back to bounces@ (the envelope), not to orders@ (the From that Ana sees)',
);
await server.close();
