// MIME parser: the way back. Headers (with unfolding), blank line, body;
// multipart is split by the boundary, and each part is decoded (base64, quoted-printable).
import { decodeQP, decodeWords } from './encoding.ts';

export type Headers = Map<string, string[]>; // lowercase name → values (Received can repeat)
export type Part = {
  headers: Headers;
  type: string; // "text/plain", "multipart/alternative"...
  params: Record<string, string>; // boundary, charset, name...
  content: Buffer; // body already decoded (empty in multipart)
  filename?: string;
  children: Part[];
};

export const first = (h: Headers, name: string) => h.get(name.toLowerCase())?.[0];

// Splits headers and body at the first blank line and undoes the folding (CRLF followed by a space)
export function splitHead(raw: string): { headers: Headers; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at + 4);
  const headers: Headers = new Map();
  for (const line of head.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  return { headers, body };
}

// 'multipart/mixed; boundary="abc"' → { type: 'multipart/mixed', params: { boundary: 'abc' } }
export function parseContentType(value = 'text/plain; charset=us-ascii') {
  const [type, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: type.trim().toLowerCase(), params };
}

// Splits the body of a multipart into its parts. A "--boundary" line opens a part; "--boundary--" closes everything.
// What comes before the first one (preamble) and after the closing one (epilogue) is ignored (RFC 2046 5.1.1).
export function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;
  const parts: string[] = [];
  let current: string[] | null = null; // null = still in the preamble (no part open yet)

  for (const line of body.split('\r\n')) {
    // only the WHOLE line is a delimiter; trailing spaces are allowed (RFC 2046: "transport padding")
    const candidate = line.trimEnd();
    if (candidate === closeDelimiter) break; // the rest is the epilogue
    if (candidate === delimiter) {
      if (current) parts.push(current.join('\r\n'));
      current = [];
    } else if (current) {
      current.push(line); // the original line, without trimEnd: the content stays byte for byte
    }
  }
  // closes the last part, both after the closing delimiter and when it is missing (a truncated message)
  if (current) parts.push(current.join('\r\n'));
  return parts;
}

function decodeBody(body: string, encoding = '7bit'): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return Buffer.from(decodeQP(body), 'utf8');
  return Buffer.from(body.replace(/\r\n/g, '\n'), 'utf8');
}

export function parsePart(raw: string): Part {
  const { headers, body } = splitHead(raw);
  const { type, params } = parseContentType(first(headers, 'content-type'));
  const disposition = parseContentType(first(headers, 'content-disposition') ?? 'inline');
  const filename = disposition.params.filename ?? params.name;
  if (type.startsWith('multipart/') && params.boundary) {
    const children = splitMultipart(body, params.boundary).map(parsePart);
    return { headers, type, params, content: Buffer.alloc(0), children };
  }
  return { headers, type, params, content: decodeBody(body, first(headers, 'content-transfer-encoding')), filename, children: [] };
}

// multipart/alternative: the BEST version is the LAST one the reader can show (RFC 2046 5.1.4)
export function pickAlternative(part: Part, supported: string[]): Part | undefined {
  return [...part.children].reverse().find((c) => supported.includes(c.type));
}

export type ParsedMail = {
  headers: Headers;
  subject: string;
  from: string;
  to: string;
  messageId?: string;
  text?: string;
  html?: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  tree: Part;
};

export function parseMessage(raw: string): ParsedMail {
  const tree = parsePart(raw.replace(/\r?\n/g, '\r\n'));
  const out: ParsedMail = {
    headers: tree.headers,
    subject: decodeWords(first(tree.headers, 'subject') ?? ''),
    from: decodeWords(first(tree.headers, 'from') ?? ''),
    to: decodeWords(first(tree.headers, 'to') ?? ''),
    messageId: first(tree.headers, 'message-id'),
    attachments: [],
    tree,
  };
  const walk = (p: Part) => {
    if (p.children.length) return p.children.forEach(walk);
    if (p.filename) out.attachments.push({ filename: p.filename, contentType: p.type, content: p.content });
    else if (p.type === 'text/plain' && out.text === undefined) out.text = p.content.toString('utf8');
    else if (p.type === 'text/html' && out.html === undefined) out.html = p.content.toString('utf8');
  };
  walk(tree);
  return out;
}

// Draws the part tree: useful to debug "why does Outlook show the wrong attachment?"
export function describe(p: Part, depth = 0): string[] {
  const label = p.children.length ? p.type : `${p.type} (${p.content.length} bytes${p.filename ? `, ${p.filename}` : ''})`;
  return [`${'  '.repeat(depth)}${label}`, ...p.children.flatMap((c) => describe(c, depth + 1))];
}
