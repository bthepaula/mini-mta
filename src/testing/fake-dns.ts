// A real DNS server (UDP, RFC 1035 binary format), only tiny and with a fixed zone.
// This way the project uses Node's real resolveMx, without depending on the internet.
import dgram from 'node:dgram';
import { once } from 'node:events';

export type Zone = Record<string, { mx?: { priority: number; exchange: string }[]; a?: string[] }>;
export type FakeDns = { server: string; queries: string[]; close(): Promise<void> };

const TYPES: Record<number, string> = { 1: 'A', 15: 'MX', 28: 'AAAA' };

// "mx1.acme.test" → 3 m x 1 4 a c m e 4 t e s t 0  ("." becomes just the 0: it is the null MX)
function encodeName(name: string): Buffer {
  const labels = name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([...labels, Buffer.from([0])]);
}

function answer(type: number, rdata: Buffer): Buffer {
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c, 0); // name = pointer to the question (offset 12)
  rr.writeUInt16BE(type, 2);
  rr.writeUInt16BE(1, 4); // class IN
  rr.writeUInt32BE(60, 6); // TTL of 60 s
  rr.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([rr, rdata]);
}

export async function startDns(zone: Zone): Promise<FakeDns> {
  const socket = dgram.createSocket('udp4');
  const queries: string[] = [];
  socket.on('message', (msg, from) => {
    let offset = 12; // the question comes after the 12-byte header
    const labels: string[] = [];
    while (msg[offset] !== 0) { labels.push(msg.subarray(offset + 1, offset + 1 + msg[offset]).toString()); offset += msg[offset] + 1; }
    const qtype = msg.readUInt16BE(offset + 1);
    const question = msg.subarray(12, offset + 5);
    const name = labels.join('.').toLowerCase();
    queries.push(`${TYPES[qtype] ?? qtype} ${name}`);

    const entry = zone[name];
    const answers: Buffer[] = [];
    if (entry && qtype === 15) {
      for (const mx of entry.mx ?? []) {
        const pref = Buffer.alloc(2);
        pref.writeUInt16BE(mx.priority);
        answers.push(answer(15, Buffer.concat([pref, encodeName(mx.exchange)])));
      }
    }
    if (entry && qtype === 1) for (const ip of entry.a ?? []) answers.push(answer(1, Buffer.from(ip.split('.').map(Number))));

    const header = Buffer.alloc(12);
    header.writeUInt16BE(msg.readUInt16BE(0), 0); // same id as the question
    const rd = msg.readUInt16BE(2) & 0x0100;
    header.writeUInt16BE(0x8000 | rd | 0x0080 | (entry ? 0 : 3), 2); // response, RA; rcode 3 = NXDOMAIN
    header.writeUInt16BE(1, 4); // 1 question
    header.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([header, question, ...answers]), from.port, from.address);
  });
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  return { server: `127.0.0.1:${port}`, queries, close: () => new Promise<void>((r) => socket.close(() => r())) };
}
