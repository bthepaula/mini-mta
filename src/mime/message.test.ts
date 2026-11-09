import { describe, expect, it } from 'vitest';
import { buildMessage, envelopeOf, type MailInput } from './message.ts';
import { decodeQP, decodeWords, encodeQP, encodeWord } from './encoding.ts';
import { seeded } from '../testing/random.ts';

const base: MailInput = {
  from: 'Shop <orders@shop.test>',
  to: ['Ana <ana@acme.test>'],
  bcc: ['audit@shop.test'],
  subject: 'Order 123 confirmed',
  text: 'Hi Ana! Your order is confirmed.',
  html: '<p>Hi Ana! Your order is <b>confirmed</b>.</p>',
  date: new Date('2026-11-04T12:00:00Z'),
  random: seeded(7),
};
const lines = (raw: string) => raw.split('\r\n');
const header = (raw: string, name: string) => lines(raw).find((l) => l.startsWith(name + ': '));

describe('message building (RFC 5322 + MIME)', () => {
  it('has Date, a globally unique Message-ID and MIME-Version', () => {
    const raw = buildMessage(base);
    expect(header(raw, 'Date')).toBe('Date: Wed, 04 Nov 2026 12:00:00 +0000');
    expect(header(raw, 'Message-ID')).toMatch(/^Message-ID: <[0-9a-f]{16}@shop\.test>$/);
    expect(header(raw, 'MIME-Version')).toBe('MIME-Version: 1.0');
    expect(raw).toContain('\r\n\r\n'); // the blank line separates headers and body
  });

  it('Bcc does not show up in the headers, but goes on the envelope', () => {
    expect(buildMessage(base)).not.toContain('audit@');
    expect(envelopeOf(base)).toEqual({ from: 'orders@shop.test', to: ['ana@acme.test', 'audit@shop.test'] });
  });

  it('text + html become multipart/alternative, from the simplest (text) to the preferred (html)', () => {
    const raw = buildMessage(base);
    expect(header(raw, 'Content-Type')).toMatch(/^Content-Type: multipart\/alternative; boundary="=_alternative_/);
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
  });

  it('an attachment becomes multipart/mixed with base64 in lines of up to 76 characters', () => {
    const pdf = Buffer.alloc(300, 0xff); // bytes that are not text
    const raw = buildMessage({ ...base, attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: pdf }] });
    expect(header(raw, 'Content-Type')).toMatch(/multipart\/mixed/);
    const start = raw.indexOf('filename="invoice.pdf"\r\n\r\n') + 'filename="invoice.pdf"\r\n\r\n'.length;
    const b64 = raw.slice(start, raw.indexOf('\r\n--', start));
    expect(Math.max(...lines(b64).map((l) => l.length))).toBe(76);
    expect(Buffer.from(b64.replace(/\r\n/g, ''), 'base64').equals(pdf)).toBe(true);
  });

  it('no line is longer than 78 characters, not even with a single-line HTML', () => {
    const raw = buildMessage({ ...base, html: '<td>' + 'café '.repeat(400) + '</td>' });
    expect(Math.max(...lines(raw).map((l) => l.length))).toBeLessThanOrEqual(78);
  });

  it('an accented subject becomes an encoded-word and comes back the same; a long subject is folded', () => {
    const subject = 'Your café order #123 is confirmed and already on its way to your home ✓';
    const encoded = encodeWord(subject);
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(encoded).toContain('\r\n '); // folding: continues on the next line, starting with a space
    expect(encoded.split('\r\n ').every((w) => w.length <= 75)).toBe(true);
    expect(decodeWords(encoded)).toBe(subject);
  });

  it('quoted-printable: accents and "=" become =XX, a space at the end of a line becomes =20, and everything comes back the same', () => {
    const text = 'Café: 2 = 1 \nend';
    const qp = encodeQP(text);
    expect(qp).toBe('Caf=C3=A9: 2 =3D 1=20\r\nend');
    expect(decodeQP(qp)).toBe(text);
  });

  it('the boundary does not show up inside any part', () => {
    const raw = buildMessage({ ...base, attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('--=_x') }] });
    const boundaries = [...raw.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]);
    for (const b of boundaries) {
      const uses = lines(raw).filter((l) => l.includes(b));
      expect(uses.every((l) => l === `--${b}` || l === `--${b}--` || l.includes('boundary='))).toBe(true);
    }
  });
});
