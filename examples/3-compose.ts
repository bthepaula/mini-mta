// Builds the message that a "POST /emails" with from, to, subject, text, html and one attachment becomes under the hood.
// Below the important lines, "↳" says what they mean (EXPLAIN=0 turns it off).
import { buildMessage, envelopeOf, type MailInput } from '../src/mime/message.ts';
import { seeded } from '../src/testing/random.ts';
import { note, show, showMessage } from './lib/explain.ts';

const input: MailInput = {
  from: 'Café Zoë <orders@shop.test>',
  to: ['Ana <ana@acme.test>'],
  bcc: ['audit@shop.test'],
  subject: 'Your café order #123 is confirmed ✓',
  text: 'Hi Ana! Your café order #123 is confirmed.\nTotal: $99.90',
  html: '<p>Hi Ana! Your café order <b>#123</b> is confirmed.</p><p>Total: $99.90</p>',
  attachments: [{ filename: 'order-123.csv', contentType: 'text/csv', content: Buffer.from('item,qty,price\nmug,2,99.90\n') }],
  headers: { 'X-Entity-Ref-ID': 'order-123' }, // an extra header, like the API's "headers" field
  date: new Date('2026-11-04T12:00:00Z'),
  random: seeded(2026),
};

note(
  'The story: the mail system is old and only understands simple letters, no accents. But our letter has',
  '   "é", "ë", "✓", fancy text (HTML) and an attached file. So we "wrap" everything',
  '   using the MIME rules. Below is the wrapped letter, exactly as it travels through the mail:',
  '',
);
const raw = buildMessage(input);
showMessage(raw);
const all = raw.split('\r\n');
console.log('---');
show(
  `envelope: MAIL FROM ${envelopeOf(input).from} · RCPT TO ${envelopeOf(input).to.join(', ')}`,
  'audit@ (the Bcc) is on the ENVELOPE, but it does not show up on any line of the letter above: it is the hidden copy',
);
show(
  `lines: ${all.length} · longest line: ${Math.max(...all.map((l) => l.length))} characters · ${Buffer.byteLength(raw)} bytes`,
  'no line is longer than 76 little letters: the long ones were broken up, because the mail system doesn\'t like long lines',
);
