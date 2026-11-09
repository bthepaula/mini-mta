import { afterEach, describe as group, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { buildMessage } from './message.ts';
import { describe, parseMessage, parsePart, pickAlternative, splitHead, splitMultipart } from './parse.ts';
import { startSmtpServer, type SmtpServer } from '../smtp/server.ts';
import { seeded } from '../testing/random.ts';

let server: SmtpServer | undefined;
afterEach(() => server?.close());
const csv = Buffer.from('item,qty\nmug,2\n');

group('MIME parser', () => {
  it('round trip: what buildMessage builds, parseMessage reads back the same', () => {
    const raw = buildMessage({
      from: 'Café Zoë <orders@shop.test>', to: ['ana@acme.test'], subject: 'Café order #123 ✓',
      text: 'Hi, Zoë!\nTotal: $99.90', html: '<p>Hi, <b>Zoë</b>!</p>',
      attachments: [{ filename: 'order.csv', contentType: 'text/csv', content: csv }], random: seeded(1),
    });
    const mail = parseMessage(raw);
    expect(mail.subject).toBe('Café order #123 ✓');
    expect(mail.from).toBe('Café Zoë <orders@shop.test>');
    expect(mail.text).toBe('Hi, Zoë!\nTotal: $99.90');
    expect(mail.html).toBe('<p>Hi, <b>Zoë</b>!</p>');
    expect(mail.attachments[0].filename).toBe('order.csv');
    expect(mail.attachments[0].content.equals(csv)).toBe(true);
  });

  it('undoes the folding: removes the CRLF and keeps the space that starts the continuation', () => {
    const { headers } = splitHead('Subject: one line\r\n that continues\r\nTo: a@b.test\r\n\r\nbody');
    expect(headers.get('subject')).toEqual(['one line that continues']);
  });

  it('ignores preamble and epilogue, and only accepts the boundary as a whole line', () => {
    const body = 'text for readers without MIME\r\n--b1\r\npart 1\r\n--b1extra is not a delimiter\r\n--b1  \r\npart 2\r\n--b1--\r\nepilogue';
    expect(splitMultipart(body, 'b1')).toEqual(['part 1\r\n--b1extra is not a delimiter', 'part 2']);
  });

  it('multipart/alternative: picks the last version the reader supports', () => {
    const raw = buildMessage({ from: 'a@shop.test', to: ['b@acme.test'], subject: 's', text: 'text', html: '<p>html</p>', random: seeded(2) });
    const tree = parsePart(raw);
    expect(pickAlternative(tree, ['text/plain', 'text/html'])?.type).toBe('text/html');
    expect(pickAlternative(tree, ['text/plain'])?.type).toBe('text/plain'); // a text-only reader
  });

  it('draws the part tree', () => {
    const raw = buildMessage({ from: 'a@shop.test', to: ['b@acme.test'], subject: 's', text: 'hi', html: '<p>hi</p>', attachments: [{ filename: 'p.csv', contentType: 'text/csv', content: csv }], random: seeded(3) });
    expect(describe(parsePart(raw))).toEqual([
      'multipart/mixed',
      '  multipart/alternative',
      '    text/plain (2 bytes)',
      '    text/html (9 bytes)',
      '  text/csv (15 bytes, p.csv)',
    ]);
  });

  it('reads a message built by nodemailer and delivered to our server', async () => {
    server = await startSmtpServer({ domains: ['acme.test'] });
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.port, secure: false, ignoreTLS: true });
    await transport.sendMail({
      from: 'Shop <orders@shop.test>', to: 'ana@acme.test', subject: 'Café order confirmation',
      text: 'Order confirmed', html: '<p>Order <b>confirmed</b></p>',
      attachments: [{ filename: 'order.csv', content: csv }],
    });
    const mail = parseMessage(server.inbox[0].raw);
    expect(mail.subject).toBe('Café order confirmation');
    expect(mail.text?.trim()).toBe('Order confirmed');
    expect(mail.html).toContain('<b>confirmed</b>');
    expect(mail.attachments.map((a) => a.filename)).toEqual(['order.csv']);
    expect(mail.attachments[0].content.equals(csv)).toBe(true);
    expect(mail.messageId).toMatch(/^<.+@shop\.test>$/);
  });
});
