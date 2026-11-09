import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { startSmtpServer, type ServerOptions, type SmtpServer } from './server.ts';
import { dotStuff, sendMail } from './client.ts';

let server: SmtpServer;
afterEach(() => server?.close());
const mx = async (opts: ServerOptions = {}) => {
  server = await startSmtpServer({ hostname: 'mx.acme.test', domains: ['acme.test'], mailboxes: ['ana@acme.test', 'bia@acme.test'], ...opts });
  return server;
};
const msg = 'From: Shop <orders@shop.test>\r\nTo: Ana <ana@acme.test>\r\nSubject: Order 123\r\n\r\nHi!\r\n';

describe('dotStuff', () => {
  it('normalizes to CRLF, doubles the leading dot and ends with CRLF', () => {
    expect(dotStuff('a\n.b\n..c')).toBe('a\r\n..b\r\n...c\r\n');
    expect(dotStuff('x\r\n')).toBe('x\r\n');
  });
});

describe('SMTP client', () => {
  it('delivers and returns the queue id', async () => {
    const s = await mx();
    const r = await sendMail({ port: s.port, from: 'orders@shop.test', to: ['ana@acme.test'], data: msg });
    expect(r.ok && r.queuedId).toBe('Q0001');
    expect(s.inbox[0].envelope.rcptTo).toEqual(['ana@acme.test']);
  });

  it('envelope × header: the Bcc only exists on the envelope', async () => {
    const s = await mx();
    await sendMail({ port: s.port, from: 'orders@shop.test', to: ['ana@acme.test', 'bia@acme.test'], data: msg });
    expect(s.inbox[0].envelope.rcptTo).toEqual(['ana@acme.test', 'bia@acme.test']);
    expect(s.inbox[0].raw).not.toContain('bia@'); // the To: header only has Ana
  });

  it('partial rejection: one RCPT 550 does not stop the others', async () => {
    const s = await mx();
    const r = await sendMail({ port: s.port, from: 'a@shop.test', to: ['ana@acme.test', 'carlos@acme.test'], data: msg });
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([{ address: 'carlos@acme.test', code: 550, text: '5.1.1 <carlos@acme.test>: mailbox unavailable' }]);
  });

  it('all rejected: permanent failure at RCPT, without sending DATA', async () => {
    const s = await mx();
    const r = await sendMail({ port: s.port, from: 'a@shop.test', to: ['carlos@acme.test'], data: msg });
    expect(r).toMatchObject({ ok: false, stage: 'rcpt', code: 550, permanent: true });
    expect(r.transcript.some((l) => l === 'C: DATA')).toBe(false);
  });

  it('greylisting is temporary (451): the sender should try again later', async () => {
    const s = await mx({ greylist: true });
    const r = await sendMail({ port: s.port, from: 'a@shop.test', to: ['ana@acme.test'], data: msg });
    expect(r).toMatchObject({ ok: false, stage: 'rcpt', code: 451, permanent: false });
    const again = await sendMail({ port: s.port, from: 'a@shop.test', to: ['ana@acme.test'], data: msg });
    expect(again.ok).toBe(true);
  });

  it('nobody listening on the port: temporary connection failure', async () => {
    const tmp = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => tmp.once('listening', r));
    const port = (tmp.address() as net.AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const r = await sendMail({ port, from: 'a@shop.test', to: ['ana@acme.test'], data: msg });
    expect(r).toMatchObject({ ok: false, stage: 'connect', code: null, permanent: false });
  });

  it('authenticated submission: without AUTH gives 530, with AUTH it delivers', async () => {
    const s = await mx({ auth: { resend: 're_lab_123' } });
    const noAuth = await sendMail({ port: s.port, from: 'a@shop.test', to: ['ze@gmail.test'], data: msg });
    expect(noAuth).toMatchObject({ ok: false, stage: 'mail', code: 530 });
    const withAuth = await sendMail({ port: s.port, auth: { user: 'resend', pass: 're_lab_123' }, from: 'a@shop.test', to: ['ze@gmail.test'], data: msg });
    expect(withAuth.ok).toBe(true);
  });

  it('a line with just a dot in the body arrives intact', async () => {
    const s = await mx();
    await sendMail({ port: s.port, from: 'a@shop.test', to: ['ana@acme.test'], data: 'Subject: x\r\n\r\nbefore\r\n.\r\nafter\r\n' });
    expect(s.inbox[0].raw.endsWith('\r\nbefore\r\n.\r\nafter\r\n')).toBe(true);
  });
});

describe('our server against a real library (nodemailer)', () => {
  it('nodemailer talks to our server and the envelope comes out right', async () => {
    const s = await mx();
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: s.port, secure: false, ignoreTLS: true });
    const info = await transport.sendMail({ from: 'Shop <orders@shop.test>', to: 'ana@acme.test', bcc: 'bia@acme.test', subject: 'Hi', text: 'Hi!' });
    expect(info.response).toMatch(/^250 /);
    expect(s.inbox[0].envelope).toEqual({ mailFrom: 'orders@shop.test', rcptTo: ['ana@acme.test', 'bia@acme.test'] });
    expect(s.inbox[0].raw).not.toContain('bia@');
  });

  it('with requireTLS nodemailer refuses to send: the server does not offer STARTTLS', async () => {
    const s = await mx();
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: s.port, secure: false, requireTLS: true });
    await expect(transport.sendMail({ from: 'a@shop.test', to: 'ana@acme.test', subject: 'x', text: 'x' })).rejects.toThrow(/STARTTLS/);
    expect(s.inbox).toHaveLength(0);
  });
});
