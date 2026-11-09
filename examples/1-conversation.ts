
// An SMTP conversation "by hand": every command and every reply shows up in the terminal.
// C: is the client (who sends), S: is the server (the MX of acme.test).
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import { startSmtpServer } from '../src/smtp/server.ts';
import { connect } from '../src/smtp/wire.ts';
import { CAST, REPLY_CODES, explainSmtp, note, show, showMessage } from './lib/explain.ts';

const server = await startSmtpServer({
  hostname: 'mx.acme.test',
  domains: ['acme.test'],
  mailboxes: ['ana@acme.test'],
  now: () => new Date('2026-11-04T12:00:00Z'), // fixed date: the output is reproducible
});
note(...CAST());
const wire = await connect(server.port, '127.0.0.1', (dir, line) => show(`${dir}: ${line}`, explainSmtp(dir, line)));

await wire.reply(); // 220: the server speaks first
for (const cmd of ['EHLO shop.test', 'MAIL FROM:<orders@shop.test>', 'RCPT TO:<ana@acme.test>', 'RCPT TO:<bia@acme.test>', 'DATA']) {
  wire.send(cmd);
  await wire.reply();
}
// The content: headers, blank line, body. No accents on purpose: accents are MIME's job (see 3-compose.ts).
const message = [
  'From: Shop <orders@shop.test>',
  'To: Ana <ana@acme.test>',
  'Subject: Order 123 confirmed',
  'Date: Wed, 04 Nov 2026 12:00:00 +0000',
  'Message-ID: <order-123@shop.test>',
  '',
  'Hi Ana! Your order 123 is confirmed.',
  '..this line starts with a dot, so the client doubled the dot',
  '.',
].join('\r\n') + '\r\n';
wire.write(message);
await wire.reply();
wire.send('QUIT');
await wire.reply();
wire.close();
note(...REPLY_CODES());

const [stored] = server.inbox;
console.log(`\n--- what ended up in the mailbox (${stored.id}) ---`);
show(
  `envelope: MAIL FROM ${stored.envelope.mailFrom} → RCPT TO ${stored.envelope.rcptTo.join(', ')}`,
  'the ENVELOPE: who it is from (to send it back) and who to deliver it to. Bia is not here because the doorman refused her',
);
showMessage(stored.raw);
await server.close();
