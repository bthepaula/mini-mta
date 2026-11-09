// Builds an RFC 5322 + MIME message, like an email API does for you from the JSON.
// Structure with an attachment: multipart/mixed [ multipart/alternative [ text/plain, text/html ], attachment... ]
import { base64Lines, encodeQP, encodeWord } from './encoding.ts';

export type Attachment = { filename: string; contentType: string; content: Buffer };
export type MailInput = {
  from: string; // "Name <email>" or just the email
  to: string[];
  cc?: string[];
  bcc?: string[]; // never becomes a header: only goes on the envelope
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>; // extra headers, like the "headers" field of the Resend API
  date?: Date;
  messageId?: string;
  random?: () => number; // for reproducible boundary and Message-ID
};

export const addressOf = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();
const domainOf = (a: string) => addressOf(a).split('@')[1];
const randomHex = (random: () => number, n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');

// "Café Zoë <x@y>": the accented name becomes an encoded-word; the address stays intact
function formatAddress(a: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(a);
  return m && m[1] ? `${encodeWord(m[1].replace(/^"|"$/g, ''))} <${m[2]}>` : a;
}

// Date in RFC 5322 format: "Wed, 04 Nov 2026 12:00:00 +0000"
export const rfc5322Date = (d: Date) => d.toUTCString().replace('GMT', '+0000');

// Globally unique: something random + the sender's domain
export const makeMessageId = (domain: string, random: () => number) => `<${randomHex(random, 16)}@${domain}>`;

// Envelope = who really receives it (To + Cc + Bcc) and the return address
export function envelopeOf(m: MailInput) {
  return { from: addressOf(m.from), to: [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map(addressOf) };
}

type Part = { headers: string[]; body: string };
const textPart = (content: string, subtype: 'plain' | 'html'): Part => ({
  headers: [`Content-Type: text/${subtype}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable'],
  body: encodeQP(content),
});
const attachmentPart = (a: Attachment): Part => ({
  headers: [`Content-Type: ${a.contentType}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`],
  body: base64Lines(a.content),
});
// "=_" never shows up in quoted-printable or base64: the boundary doesn't collide with the content
function multipart(subtype: 'mixed' | 'alternative', parts: Part[], random: () => number): Part {
  const boundary = `=_${subtype}_${randomHex(random, 12)}`;
  const body = parts.map((p) => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}\r\n`).join('') + `--${boundary}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

export function buildMessage(m: MailInput): string {
  const random = m.random ?? Math.random;
  const bodies: Part[] = [];
  if (m.text !== undefined) bodies.push(textPart(m.text, 'plain')); // order: from the simplest to the preferred
  if (m.html !== undefined) bodies.push(textPart(m.html, 'html'));
  if (!bodies.length) bodies.push(textPart('', 'plain'));
  let root = bodies.length === 2 ? multipart('alternative', bodies, random) : bodies[0];
  if (m.attachments?.length) root = multipart('mixed', [root, ...m.attachments.map(attachmentPart)], random);

  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(formatAddress).join(', ')}`] : []),
    ...(m.replyTo ? [`Reply-To: ${formatAddress(m.replyTo)}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc5322Date(m.date ?? new Date())}`,
    `Message-ID: ${m.messageId ?? makeMessageId(domainOf(m.from), random)}`,
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
    ...root.headers,
  ];
  return headers.join('\r\n') + '\r\n\r\n' + root.body + '\r\n';
}
