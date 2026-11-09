import { afterEach, describe, expect, it } from 'vitest';
import { startSmtpServer, type ServerOptions, type SmtpServer } from './server.ts';
import { connect, type Wire } from './wire.ts';

let server: SmtpServer;
afterEach(() => server?.close());

// Starts a server, connects, reads the 220 and returns a "cmd → reply" shortcut
async function session(opts: ServerOptions = {}) {
  server = await startSmtpServer({ hostname: 'mx.acme.test', domains: ['acme.test'], mailboxes: ['ana@acme.test', 'bia@acme.test'], ...opts });
  const wire: Wire = await connect(server.port);
  const greeting = await wire.reply();
  const say = async (line: string) => { wire.send(line); return wire.reply(); };
  return { wire, greeting, say };
}

describe('SMTP server (RFC 5321)', () => {
  it('greets with 220 and announces extensions in a multi-line reply', async () => {
    const { greeting, say } = await session();
    expect(greeting.code).toBe(220);
    const ehlo = await say('EHLO client.test');
    expect(ehlo.code).toBe(250);
    expect(ehlo.lines[0]).toMatch(/^250-mx\.acme\.test/);
    expect(ehlo.lines.at(-1)).toMatch(/^250 /); // the last line has a space, not a hyphen
    expect(ehlo.text).toContain('SIZE 1000000');
    expect(ehlo.text).toContain('8BITMIME');
  });

  it('a full transaction stores the envelope and the content, with Return-Path and Received on top', async () => {
    const { wire, say } = await session();
    await say('EHLO shop.test');
    expect((await say('MAIL FROM:<orders@shop.test>')).code).toBe(250);
    expect((await say('RCPT TO:<ana@acme.test>')).code).toBe(250);
    expect((await say('DATA')).code).toBe(354);
    wire.write('From: orders@shop.test\r\nSubject: hi\r\n\r\nbody\r\n.\r\n');
    const done = await wire.reply();
    expect(done.text).toMatch(/queued as Q0001/);
    const [msg] = server.inbox;
    expect(msg.envelope).toEqual({ mailFrom: 'orders@shop.test', rcptTo: ['ana@acme.test'] });
    expect(msg.raw.split('\r\n')[0]).toBe('Return-Path: <orders@shop.test>');
    expect(msg.raw.split('\r\n')[1]).toMatch(/^Received: from shop\.test by mx\.acme\.test with ESMTP id Q0001; /);
    expect(msg.raw.endsWith('\r\nbody\r\n')).toBe(true);
  });

  it('requires EHLO before MAIL and MAIL before RCPT (503: bad sequence)', async () => {
    const { say } = await session();
    expect((await say('MAIL FROM:<a@shop.test>')).code).toBe(503);
    await say('EHLO shop.test');
    expect((await say('RCPT TO:<ana@acme.test>')).code).toBe(503);
  });

  it('refuses a missing mailbox (550 5.1.1) and a third-party domain (550 5.7.1, not an open relay)', async () => {
    const { say } = await session();
    await say('EHLO shop.test');
    await say('MAIL FROM:<a@shop.test>');
    const missing = await say('RCPT TO:<carlos@acme.test>');
    expect([missing.code, missing.text.slice(0, 5)]).toEqual([550, '5.1.1']);
    const thirdParty = await say('RCPT TO:<ze@gmail.test>');
    expect([thirdParty.code, thirdParty.text.slice(0, 5)]).toEqual([550, '5.7.1']);
  });

  it('DATA without an accepted recipient gives 554', async () => {
    const { say } = await session();
    await say('EHLO shop.test');
    await say('MAIL FROM:<a@shop.test>');
    expect((await say('DATA')).code).toBe(554);
  });

  it('removes the doubled dot (transparency, RFC 5321 4.5.2)', async () => {
    const { wire, say } = await session();
    await say('EHLO shop.test');
    await say('MAIL FROM:<a@shop.test>');
    await say('RCPT TO:<ana@acme.test>');
    await say('DATA');
    wire.write('Subject: x\r\n\r\n..\r\n..line\r\n.\r\n');
    await wire.reply();
    expect(server.inbox[0].raw.endsWith('\r\n\r\n.\r\n.line\r\n')).toBe(true);
  });

  it('accepts the null sender MAIL FROM:<> (used in bounces)', async () => {
    const { say } = await session();
    await say('EHLO mailer-daemon.test');
    expect((await say('MAIL FROM:<>')).code).toBe(250);
  });

  it('refuses a large message already at MAIL when the client declares SIZE (552)', async () => {
    const { say } = await session({ maxSize: 1000 });
    await say('EHLO shop.test');
    expect((await say('MAIL FROM:<a@shop.test> SIZE=5000')).code).toBe(552);
  });

  it('as an MSA: without AUTH gives 530; wrong password 535; right one 235 and accepts any destination', async () => {
    const { say } = await session({ auth: { resend: 're_lab_123' }, domains: [], mailboxes: undefined });
    const ehlo = await say('EHLO app.shop.test');
    expect(ehlo.text).toContain('AUTH PLAIN');
    expect((await say('MAIL FROM:<a@shop.test>')).code).toBe(530);
    const plain = (user: string, pass: string) => Buffer.from(`\0${user}\0${pass}`).toString('base64');
    expect((await say(`AUTH PLAIN ${plain('resend', 'wrong')}`)).code).toBe(535);
    expect((await say(`AUTH PLAIN ${plain('resend', 're_lab_123')}`)).code).toBe(235);
    await say('MAIL FROM:<a@shop.test>');
    expect((await say('RCPT TO:<anyone@gmail.test>')).code).toBe(250);
  });

  it('greylisting: the 1st attempt gets 451 (temporary), the 2nd goes through', async () => {
    const { say } = await session({ greylist: true });
    await say('EHLO shop.test');
    await say('MAIL FROM:<a@shop.test>');
    expect((await say('RCPT TO:<ana@acme.test>')).code).toBe(451);
    expect((await say('RCPT TO:<ana@acme.test>')).code).toBe(250);
  });

  it('an unknown command gives 500 and the session goes on', async () => {
    const { say } = await session();
    expect((await say('HOLA')).code).toBe(500);
    expect((await say('NOOP')).code).toBe(250);
    expect((await say('QUIT')).code).toBe(221);
  });
});
