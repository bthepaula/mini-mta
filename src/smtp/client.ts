// SMTP client: drives the conversation and returns a result (never throws).
// The envelope (from/to) is separate from the content (data): the envelope decides who receives it.
import { connect, type Reply, type Wire } from './wire.ts';

export type SendInput = {
  port: number;
  host?: string;
  heloName?: string;
  auth?: { user: string; pass: string }; // AUTH PLAIN, as in submission (port 587)
  from: string; // MAIL FROM: return address (where bounces go)
  to: string[]; // RCPT TO: who actually receives it (includes the Bcc)
  data: string; // the ready message: headers, blank line, body
};
export type Stage = 'connect' | 'greeting' | 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data';
export type Rejected = { address: string; code: number; text: string };
export type SendResult =
  | { ok: true; queuedId: string | null; accepted: string[]; rejected: Rejected[]; transcript: string[] }
  | { ok: false; stage: Stage; code: number | null; text: string; permanent: boolean; rejected: Rejected[]; transcript: string[] };

// 4xx = temporary (try again later); 5xx = permanent (don't repeat it as is)
export const isPermanent = (code: number | null) => code !== null && code >= 500;

// Transparency (RFC 5321 4.5.2): every line starting with "." gets another "."; everything in CRLF; ends with CRLF.
export function dotStuff(data: string): string {
  // 1. every line break becomes CRLF ("\r?" keeps an existing "\r\n" from turning into "\r\r\n")
  const crlf = data.replace(/\r?\n/g, '\r\n');
  // 2. one more "." at the start of each line. A line starts at the beginning of the text (^, without the m flag)
  //    or right after a CRLF; a lone "\r" is not a line break in SMTP, so it doesn't count
  const stuffed = crlf.replace(/(^|\r\n)\./g, '$1..');
  // 3. ends with CRLF, so the ".\r\n" the caller adds becomes the terminator "\r\n.\r\n"
  return stuffed.endsWith('\r\n') ? stuffed : stuffed + '\r\n';
}

export async function sendMail(input: SendInput): Promise<SendResult> {
  const transcript: string[] = [];
  const accepted: string[] = [];
  const rejected: Rejected[] = [];
  let stage: Stage = 'connect';
  let wire: Wire;
  try {
    wire = await connect(input.port, input.host, (dir, line) => transcript.push(`${dir}: ${line}`));
  } catch (error) {
    return { ok: false, stage, code: null, text: (error as Error).message, permanent: false, rejected, transcript };
  }
  const fail = (reply: Reply): SendResult => {
    wire.send('QUIT'); // polite: ends the session even on error
    wire.close();
    return { ok: false, stage, code: reply.code, text: reply.text, permanent: isPermanent(reply.code), rejected, transcript };
  };
  const ask = async (line: string) => { wire.send(line); return wire.reply(); };

  try {
    stage = 'greeting';
    let reply = await wire.reply();
    if (reply.code !== 220) return fail(reply);
    stage = 'ehlo';
    reply = await ask(`EHLO ${input.heloName ?? 'client.lab.test'}`);
    if (reply.code !== 250) return fail(reply);
    if (input.auth) {
      stage = 'auth';
      reply = await ask(`AUTH PLAIN ${Buffer.from(`\0${input.auth.user}\0${input.auth.pass}`).toString('base64')}`);
      if (reply.code !== 235) return fail(reply);
    }
    // MAIL FROM: the return address on the ENVELOPE (where bounces go), not the From: header
    stage = 'mail';
    reply = await ask(`MAIL FROM:<${input.from}>`);
    if (reply.code !== 250) return fail(reply);

    // RCPT TO: one per recipient. This is what decides who receives it (the Bcc included)
    stage = 'rcpt';
    for (const address of input.to) {
      reply = await ask(`RCPT TO:<${address}>`);
      // 251 = "not local, I'll forward it": the server still took responsibility, so it counts as accepted
      if (reply.code === 250 || reply.code === 251) accepted.push(address);
      // one refusal doesn't cancel the letter for the others: write it down and go on to the next one
      else rejected.push({ address, code: reply.code, text: reply.text });
    }
    // nobody accepted: fail with the LAST reply (550 = permanent, 451 = temporary) and don't send DATA for nothing
    if (accepted.length === 0) return fail(reply);

    // DATA: 354 = "go ahead"; the body goes dot-stuffed and the ".\r\n" closes the terminator "\r\n.\r\n"
    stage = 'data';
    reply = await ask('DATA');
    if (reply.code !== 354) return fail(reply);
    wire.write(dotStuff(input.data) + '.\r\n');
    reply = await wire.reply();
    if (reply.code !== 250) return fail(reply);
    const queuedId = /queued as (\S+)/.exec(reply.text)?.[1] ?? null;

    // QUIT: the message is already the server's job; a failure from here on doesn't change the result
    await ask('QUIT').catch(() => null);
    wire.close();
    return { ok: true, queuedId, accepted, rejected, transcript };
  } catch (error) {
    // the connection dropped midway: we don't know if the server accepted it, so it is temporary
    return { ok: false, stage, code: null, text: (error as Error).message, permanent: false, rejected, transcript };
  }
}
