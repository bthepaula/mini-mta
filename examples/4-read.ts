// A real library (nodemailer) builds and sends; our server receives; our parser reads.
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import nodemailer from 'nodemailer';
import { startSmtpServer } from '../src/smtp/server.ts';
import { describe, first, parseMessage } from '../src/mime/parse.ts';
import { explainHeader, note, show } from './lib/explain.ts';

const server = await startSmtpServer({ hostname: 'mx.acme.test', domains: ['acme.test'], now: () => new Date('2026-11-04T12:00:00Z') });
const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.port, secure: false, ignoreTLS: true, name: 'smtp.shop.test' });
const info = await transport.sendMail({
  from: 'Shop <orders@shop.test>',
  to: 'Ana <ana@acme.test>',
  bcc: 'audit@acme.test',
  subject: 'Your café order #123 is confirmed ✓',
  text: 'Hi Ana! Your café order #123 is confirmed.',
  html: '<p>Hi Ana! Your café order <b>#123</b> is confirmed.</p>',
  attachments: [{ filename: 'order-123.csv', content: 'item,qty,price\nmug,2,99.90\n' }],
  headers: { 'X-Entity-Ref-ID': 'order-123' },
});
note(
  'The story: this time a "professional" mail carrier wraps and delivers the letter (nodemailer,',
  '   a library lots of people use). Our doorman receives it, and our reader (the parser) UNWRAPS',
  '   the letter to see what is inside. If our reader understands another program\'s letter, it works right.',
  '',
);
show(`nodemailer: ${info.response}`, 'the doorman answered 250 to nodemailer: "got it, saved as number Q0001"');
show(
  `envelope it sent: ${info.envelope.from} → ${info.envelope.to.join(', ')}`,
  'on the ENVELOPE, nodemailer put Ana and also audit@ (the hidden copy, Bcc)',
);

const mail = parseMessage(server.inbox[0].raw);
console.log('\nheaders (the trace ones first, added on delivery):');
for (const name of ['return-path', 'received', 'from', 'to', 'subject', 'mime-version', 'x-entity-ref-id']) {
  const value = name === 'subject' ? mail.subject ?? '' : first(mail.headers, name) ?? '';
  const exp = name === 'subject'
    ? 'the subject ALREADY unwrapped: the reader undid the =?UTF-8?B?...?= and the "é" and "✓" are back'
    : explainHeader(name, value);
  show(`  ${name}: ${value}`, exp, '     ');
}
show(
  `  message-id: ${mail.messageId?.replace(/<[^@]+@/, '<…@')}`,
  'the letter\'s "ID card", made by nodemailer (the middle changes every time, so it shows as …)',
  '     ',
);
note('  (there is no "bcc" header: the hidden copy was only on the envelope)');
console.log('\nMIME tree:');
const explainTree = (line: string): string | null => {
  const l = line.trim();
  if (l === 'multipart/mixed') return 'the big BOX: it holds the letter and the attachment';
  if (l === 'multipart/alternative') return 'inside it, a little package with the SAME letter written two ways';
  if (l.startsWith('text/plain')) return 'way 1: plain text, no decoration';
  if (l.startsWith('text/html')) return 'way 2: fancy text (HTML). The app shows this one if it can';
  if (l.includes(',')) return 'the attachment: the file that comes with the letter';
  return null;
};
for (const l of describe(mail.tree)) show('  ' + l, explainTree(l), '  ' + ' '.repeat(l.length - l.trimStart().length) + '   ');
show(`\ntext: ${mail.text?.trim()}`, 'the plain text, already unwrapped: "=C3=A9" turned back into "é"');
show(
  `attachment: ${mail.attachments[0].filename} → ${JSON.stringify(mail.attachments[0].content.toString())}`,
  'the attachment back to the original: the base64 "alphabet soup" turned into the spreadsheet again (\\n is the end of each line)',
);
await server.close();
