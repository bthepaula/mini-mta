// Minimal SMTP server (RFC 5321) on node:net. It plays two roles, depending on the options:
// - MX (no auth): accepts mail only for its own domains and does the final delivery;
// - MSA (with auth, like port 587): requires AUTH PLAIN and accepts any destination, to relay it.
import net from 'node:net';
import { once } from 'node:events';

export type Envelope = { mailFrom: string; rcptTo: string[] };
export type Stored = { id: string; helo: string; envelope: Envelope; raw: string };
export type ServerOptions = {
  hostname?: string; // name announced in the 220 greeting and in EHLO
  domains?: string[]; // domains this server is the MX for
  mailboxes?: string[]; // if set, only these mailboxes exist
  auth?: Record<string, string>; // user → password: turns the server into an MSA
  greylist?: boolean; // answer 451 to the 1st attempt of each sender/recipient pair
  maxSize?: number; // in bytes, announced in SIZE
  latencyMs?: number; // artificial delay before each reply (used by the benchmark)
  now?: () => Date;
};
export type SmtpServer = { port: number; inbox: Stored[]; replies: number; close(): Promise<void> };

/** One connection: who said hello, whether they logged in, and the transaction in progress. */
type Session = { helo: string | null; authed: boolean; from: string | null; rcpts: string[]; data: string[] | null };

const MAX_RECIPIENTS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
const rfc5322Date = (d: Date) => d.toUTCString().replace('GMT', '+0000');

export async function startSmtpServer(opts: ServerOptions = {}): Promise<SmtpServer> {
  const host = opts.hostname ?? 'mx.lab.test';
  const domains = (opts.domains ?? []).map((d) => d.toLowerCase());
  const maxSize = opts.maxSize ?? 1_000_000;
  const now = opts.now ?? (() => new Date());
  const greylisted = new Set<string>(); // "sender|recipient" pairs already seen once
  const inbox: Stored[] = [];
  const sockets = new Set<net.Socket>();
  let replies = 0;

  // ---------- the protocol: each function gets a line and returns the reply lines (no I/O here)

  function respond(s: Session, line: string): string[] {
    if (s.data) return receiveData(s, line);
    const [verb = '', ...args] = line.split(' ');
    switch (verb.toUpperCase()) {
      case 'EHLO': return ehlo(s, args.join(' '));
      case 'HELO': s.helo = args.join(' ') || 'unknown'; resetTransaction(s); return [`250 ${host}`];
      case 'AUTH': return auth(s, args);
      case 'MAIL': return mailFrom(s, args.join(' '));
      case 'RCPT': return rcptTo(s, args.join(' '));
      case 'DATA': return startData(s);
      case 'RSET': resetTransaction(s); return ['250 2.0.0 OK'];
      case 'NOOP': return ['250 2.0.0 OK'];
      case 'QUIT': return [`221 2.0.0 ${host} closing connection`];
      default: return ['500 5.5.2 Command not recognized'];
    }
  }

  function resetTransaction(s: Session): void {
    s.from = null;
    s.rcpts = [];
    s.data = null;
  }

  function ehlo(s: Session, domain: string): string[] {
    if (!domain) return ['501 5.5.4 EHLO needs a domain'];
    s.helo = domain;
    resetTransaction(s);
    const lines = [`${host} hello ${domain}`, `SIZE ${maxSize}`, '8BITMIME', ...(opts.auth ? ['AUTH PLAIN'] : []), 'ENHANCEDSTATUSCODES'];
    // every line but the last starts with "250-" ("there's more"); the last one with "250 " ("I'm done")
    return lines.map((l, i) => (i < lines.length - 1 ? '250-' : '250 ') + l);
  }

  function auth(s: Session, [mechanism, initial]: string[]): string[] {
    if (!opts.auth || mechanism?.toUpperCase() !== 'PLAIN' || !initial) return ['504 5.5.4 Use AUTH PLAIN with initial response'];
    // AUTH PLAIN carries "\0user\0password" in base64
    const [, user, pass] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
    if (opts.auth[user] === undefined || opts.auth[user] !== pass) return ['535 5.7.8 Authentication credentials invalid'];
    s.authed = true;
    return ['235 2.7.0 Authentication successful'];
  }

  function mailFrom(s: Session, arg: string): string[] {
    if (!s.helo) return ['503 5.5.1 Send EHLO first'];
    if (opts.auth && !s.authed) return ['530 5.7.0 Authentication required'];
    if (s.from !== null) return ['503 5.5.1 Nested MAIL command'];
    const m = /^FROM:\s*<([^>]*)>(.*)$/i.exec(arg);
    if (!m) return ['501 5.5.4 Syntax: MAIL FROM:<address>'];
    const declaredSize = Number(/SIZE=(\d+)/i.exec(m[2])?.[1] ?? 0);
    if (declaredSize > maxSize) return ['552 5.3.4 Message size exceeds fixed limit'];
    s.from = m[1]; // an empty "<>" is valid: it is the null sender of bounces
    return [`250 2.1.0 Sender <${s.from}> OK`];
  }

  function rcptTo(s: Session, arg: string): string[] {
    if (s.from === null) return ['503 5.5.1 Need MAIL before RCPT'];
    const m = /^TO:\s*<([^>]+)>/i.exec(arg);
    if (!m) return ['501 5.5.4 Syntax: RCPT TO:<address>'];
    const to = m[1].toLowerCase();
    // An MSA relays to anyone who logged in; an MX only accepts its own domains and mailboxes
    if (!s.authed) {
      if (!domains.includes(domainOf(to))) return ['550 5.7.1 Relaying denied'];
      if (opts.mailboxes && !opts.mailboxes.includes(to)) return [`550 5.1.1 <${to}>: mailbox unavailable`];
    }
    if (s.rcpts.length >= MAX_RECIPIENTS) return ['452 4.5.3 Too many recipients'];
    const pair = `${s.from}|${to}`;
    if (opts.greylist && !greylisted.has(pair)) {
      greylisted.add(pair);
      return ['451 4.7.0 Greylisted, try again later'];
    }
    s.rcpts.push(to);
    return [`250 2.1.5 Recipient <${to}> OK`];
  }

  function startData(s: Session): string[] {
    if (!s.rcpts.length) return ['554 5.5.1 No valid recipients'];
    s.data = [];
    return ['354 End data with <CR><LF>.<CR><LF>'];
  }

  // Inside DATA every line is content, until a line with a single dot
  function receiveData(s: Session, line: string): string[] {
    if (line !== '.') {
      s.data!.push(line.startsWith('.') ? line.slice(1) : line); // undoes the client's dot-stuffing
      return []; // content lines get no reply
    }
    const body = s.data!.join('\r\n') + '\r\n';
    if (Buffer.byteLength(body) > maxSize) {
      resetTransaction(s);
      return ['552 5.3.4 Message size exceeds fixed limit'];
    }
    const id = `Q${String(inbox.length + 1).padStart(4, '0')}`;
    inbox.push({ id, helo: s.helo!, envelope: { mailFrom: s.from!, rcptTo: s.rcpts }, raw: traceHeaders(s, id) + body });
    resetTransaction(s);
    return [`250 2.0.0 Ok: queued as ${id}`];
  }

  // Every stop adds a Received on top; the final delivery (the MX) also writes the envelope's Return-Path
  function traceHeaders(s: Session, id: string): string {
    const received = `Received: from ${s.helo} by ${host} with ESMTP id ${id}; ${rfc5322Date(now())}\r\n`;
    return opts.auth ? received : `Return-Path: <${s.from}>\r\n` + received;
  }

  // ---------- the network: split the stream into CRLF lines and answer them in order

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    const session: Session = { helo: null, authed: false, from: null, rcpts: [], data: null };
    let buffer = '';
    let pending = Promise.resolve(); // one line at a time, in order

    async function send(lines: string[]): Promise<void> {
      if (!lines.length) return;
      if (opts.latencyMs) await sleep(opts.latencyMs);
      replies++;
      if (!socket.destroyed) socket.write(lines.map((l) => l + '\r\n').join(''));
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        pending = pending.then(async () => {
          const reply = respond(session, line);
          await send(reply);
          if (reply[0]?.startsWith('221')) socket.end(); // QUIT
        });
      }
    });
    void send([`220 ${host} ESMTP mini-mta ready`]);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    inbox,
    get replies() { return replies; },
    close: () => new Promise<void>((r) => { server.close(() => r()); sockets.forEach((s) => s.destroy()); }),
  };
}
