// An SMTP "wire": opens a TCP socket, sends lines ending in CRLF and reads replies.
// A reply can have several lines: "250-..." continues, "250 ..." (with a space) ends it.
import net from 'node:net';
import { once } from 'node:events';

export type Reply = { code: number; lines: string[]; text: string };
export type Wire = {
  reply(): Promise<Reply>; // reads ONE complete reply (all of its lines)
  send(line: string): void; // sends a command (the CRLF is added here)
  write(data: string): void; // sends raw bytes (the content after DATA)
  close(): void;
};
export type LineLogger = (dir: 'C' | 'S', line: string) => void;

export async function connect(port: number, host = '127.0.0.1', log?: LineLogger): Promise<Wire> {
  const socket = net.createConnection({ port, host });
  await once(socket, 'connect'); // rejects with ECONNREFUSED if nobody listens on the port
  socket.setEncoding('utf8');
  const lines: string[] = [];
  let buffer = '';
  let wake: (() => void) | null = null;
  let closed = false;
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      lines.push(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
    }
    wake?.();
  });
  socket.on('close', () => { closed = true; wake?.(); });
  socket.on('error', () => {}); // 'close' comes right after and wakes up whoever is waiting

  async function nextLine(): Promise<string> {
    while (!lines.length) {
      if (closed) throw new Error('connection closed by the server');
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
    const line = lines.shift()!;
    log?.('S', line);
    return line;
  }

  return {
    async reply() {
      const out: string[] = [];
      for (;;) {
        const line = await nextLine();
        out.push(line);
        if (line[3] !== '-') break; // "250 " or "250" end it; "250-" continues
      }
      return { code: Number(out[0].slice(0, 3)), lines: out, text: out.map((l) => l.slice(4)).join('\n') };
    },
    send(line) {
      log?.('C', line);
      socket.write(line + '\r\n');
    },
    write(data) {
      log?.('C', `[${Buffer.byteLength(data)} bytes of message]`);
      socket.write(data);
    },
    close() {
      socket.end();
    },
  };
}
