// Checks the environment. Everything in this project runs on your machine: fake SMTP and DNS
// servers on 127.0.0.1, on port 0 (the OS picks a free one). No email ever leaves for real.
// Below each line, "↳" says what it means (EXPLAIN=0 turns it off).
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { seeded } from '../src/testing/random.ts';
import { show } from '../examples/lib/explain.ts';

const major = Number(process.versions.node.split('.')[0]);
const rand = seeded(42);
show(
  `Node ${process.versions.node} ${major >= 20 ? 'ok' : 'TOO OLD: install Node 20+'}`,
  'Node is the program that runs our code. It needs to be version 20 or newer',
);
show(
  `node:net (raw TCP): ${typeof net.createServer === 'function' ? 'ok' : 'missing'}`,
  '"net" opens a pipe between two programs (a TCP connection). The mail carrier and the doorman will talk through this pipe',
);
show(
  `node:dns resolveMx: ${typeof Resolver.prototype.resolveMx === 'function' ? 'ok' : 'missing'}`,
  'it asks the "internet phone book" (DNS): "which building receives the letters for this address?"',
);
// SMTP and the message format end every line with CR LF, not just LF
show(
  `SMTP line ending: CR LF = bytes ${[...Buffer.from('\r\n')].join(' ')}`,
  'every SMTP sentence ends with two invisible signs: 13 ("go back to the start of the line") and 10 ("go down one line")',
);
show(
  `seeded random: ${[rand(), rand(), rand()].map((n) => n.toFixed(3)).join(', ')}`,
  '"random" numbers that always come out the same (like dice loaded on purpose): so your output matches the README\'s',
);
