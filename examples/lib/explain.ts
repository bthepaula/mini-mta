// Each technical line gets, right below it, a line starting with "↳" that says what it means.
// The story is always the same: the email is a LETTER, the SMTP client is the MAIL CARRIER
// and the server is the DOORMAN of the building, who takes the letters for the people who live there.
//
// EXPLAIN=0 turns the explanations off: only the technical output, like a real log.
// (This file only formats text: no test depends on it, and nothing in SMTP/MIME/MX changes.)

export const explaining = process.env.EXPLAIN !== '0';

// In a terminal the explanation is dimmed (ANSI "dim"), so the technical line stands out
const dimmed = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text: string) => (dimmed ? `\x1b[2m${text}\x1b[22m` : text);

/** Prints the explanation below the previous line (or nothing, with EXPLAIN=0). */
export function explain(text: string | null | undefined, indent = '   '): void {
  if (explaining && text) console.log(dim(`${indent}↳ ${text}`));
}

/** Prints a technical line and, below it, its explanation. */
export function show(line: string, explanation?: string | null, indent = '   '): void {
  console.log(line);
  explain(explanation, indent);
}

/** A block of text that only shows up in explained mode (legends, summaries). */
export function note(...lines: string[]): void {
  if (explaining) console.log(lines.join('\n'));
}

export const CAST = (): string[] => [
  'Who is who in this conversation:',
  '   C: = the MAIL CARRIER: the program that DELIVERS the letter (the SMTP client)',
  '   S: = the DOORMAN: the server that RECEIVES letters for the building (the SMTP server)',
  '   ↳  = what that line means, said very simply',
  '',
];

// What the FIRST digit of a reply code means: the only source of these sentences (the legend and codeClass use it)
const REPLY_CLASSES: Record<number, { meaning: string; then?: string }> = {
  2: { meaning: 'it worked' },
  3: { meaning: 'okay, now give me the rest' },
  4: { meaning: 'not now, come back later', then: 'the mail carrier tries again later' },
  5: { meaning: "no, and trying again won't help", then: 'the letter goes back to the sender' },
};

export const REPLY_CODES = (): string[] => [
  '',
  'The secret of the numbers: the doorman always starts with a number, and the FIRST digit tells you everything:',
  ...Object.entries(REPLY_CLASSES).map(([digit, replyClass]) => `   ${digit}xx "${replyClass.meaning}"${replyClass.then ? ` (${replyClass.then})` : ''}`),
];

/** What the first digit of a reply code means. */
export function codeClass(code: number): string {
  const digit = Math.floor(code / 100);
  const replyClass = REPLY_CLASSES[digit];
  return replyClass ? `${digit} = ${replyClass.meaning}` : `code ${code}`;
}

const num = (value: number) => value.toLocaleString('en-US');

// ------------------------------------------------------------------ the SMTP conversation (C: and S: lines)

/** Explains one line of the SMTP conversation. dir 'C' = mail carrier (client), 'S' = doorman (server). */
export function explainSmtp(dir: 'C' | 'S', line: string): string {
  return dir === 'C' ? explainCommand(line) : explainReply(line);
}

// Each rule: if the command matches the regex, the function turns the match into the explanation. The first match wins.
type Rule = [RegExp, (match: RegExpExecArray) => string];

const COMMANDS: Rule[] = [
  [/^EHLO (.+)$/i, (match) => `"Hi! I'm the mail carrier from ${match[1]}." (EHLO = the new way to say hello)`],
  [/^HELO (.+)$/i, (match) => `"Hi! I'm ${match[1]}." (HELO is the old hello: the doorman won't list what he can do)`],
  [/^AUTH /i, () => 'The mail carrier shows his badge (username and password) to prove he is a customer of this post office'],
  [/^MAIL FROM:<(.*)>/i, (match) => match[1]
    ? `"This letter is from ${match[1]}. If you can't deliver it, send it back there." (the return address, on the ENVELOPE)`
    : '"This letter has no sender." (it is a bounce notice: if it fails, it goes back to nobody)'],
  [/^RCPT TO:<(.*)>/i, (match) => `"The letter is for ${match[1]}." (one RCPT for each person)`],
  [/^DATA$/i, () => '"Here comes the letter!"'],
  [/^\[(\d+) bytes of message\]$/, (match) =>
    `The mail carrier hands over the whole letter (${num(Number(match[1]))} little letters) and, at the end, shows a line with just one dot: "done!"`],
  [/^QUIT$/i, () => '"Bye!"'],
  [/^RSET$/i, () => '"Forget that letter, I\'m starting a new one."'],
  [/^NOOP$/i, () => '"Are you still there?"'],
  [/^STARTTLS$/i, () => '"Can we switch to secret code (TLS)?"'],
];

function explainCommand(line: string): string {
  for (const [regex, say] of COMMANDS) {
    const match = regex.exec(line);
    if (match) return say(match);
  }
  return 'The mail carrier says a command';
}

// What each extension in the EHLO list means. The key is the first word of the line ("SIZE 1000000" -> SIZE),
// the argument is the rest. Returning null means "I don't know how to explain this one".
const EXTENSIONS: Record<string, (arg: string) => string | null> = {
  SIZE: (arg) => (/^\d+$/.test(arg) ? `"I take letters up to ${num(Number(arg))} little letters long (bytes)."` : null),
  '8BITMIME': () => '"I take letters with accents and other symbols."',
  ENHANCEDSTATUSCODES: () => '"When something goes wrong, I explain why with an extra code, like 5.1.1."',
  AUTH: () => '"Here you have to show your badge (username and password) before sending letters."',
  STARTTLS: () => '"If you want, we can talk in secret code (TLS)."',
  PIPELINING: () => '"You can say several things at once, without waiting for each answer."',
};

function explainReply(line: string): string {
  const code = Number(line.slice(0, 3));
  const more = line[3] === '-'; // "250-" = more lines are coming; "250 " = the last one
  const text = line.slice(4);

  // ordered by code; a case that doesn't return falls through to the generic explanations at the end
  switch (code) {
    case 220: return `"Hi! This is ${text.split(' ')[0]}. Go ahead!" (the doorman speaks first; ${codeClass(code)})`;
    case 221: return '"Bye, see you next time!" (and closes the door)';
    case 235: return '"Badge is good, come on in!"';
    case 250: return explainOk(text, more);
    case 354: return '"Go ahead! When you\'re done, show me a line with just one dot." (<CR><LF>.<CR><LF> = new line, dot, new line)';
    case 451:
      if (/greylist/i.test(text)) {
        return `"I don't know you yet... come back in a little while." (${codeClass(code)}: a real mail carrier comes back, a spam robot gives up)`;
      }
      break;
    case 452: return `"Too many people on one letter! Send the rest later." (${codeClass(code)})`;
    case 503: return `"Wait, that's out of order!" (${codeClass(code)})`;
    case 530: return `"Show me your badge first!" (${codeClass(code)}: AUTH is missing)`;
    case 535: return `"That badge is wrong." (${codeClass(code)})`;
    case 550: {
      const match = /^5\.1\.1 <(.+)>/.exec(text);
      if (match) return `"Nobody called ${match[1]} lives here." (${codeClass(code)}; the 5.1.1 explains: "that address doesn't exist")`;
      if (text.includes('Relaying denied')) {
        return `"I only take letters for people who live in THIS building. That one is for another building!" (${codeClass(code)})`;
      }
      break;
    }
    case 552: return `"That letter is too big!" (${codeClass(code)})`;
    case 554: return `"But nobody on this letter lives here! I have no one to give it to." (${codeClass(code)})`;
  }
  if (code >= 500 && code <= 504) return `"I didn't understand what you said." (${codeClass(code)})`;
  return `Answered ${code} (${codeClass(code)})`;
}

/** The 250 replies: the EHLO greeting and its list of extensions, the OKs for MAIL/RCPT/DATA, or a plain "all good". */
function explainOk(text: string, more: boolean): string {
  let match: RegExpExecArray | null;
  if ((match = /^\S+ hello (.+)$/.exec(text))) {
    return `"Hi, ${match[1]}! Let me tell you what I can do:" (the "-" after 250 means "wait, there's more")`;
  }
  // lines of the EHLO extension list: "250-SIZE 1000000", "250 ENHANCEDSTATUSCODES"...
  const space = text.indexOf(' ');
  const [keyword, arg] = space < 0 ? [text, ''] : [text.slice(0, space), text.slice(space + 1)];
  const known = Object.hasOwn(EXTENSIONS, keyword);
  if (!/^\d\.\d/.test(text) && (more || known)) {
    const end = more ? '' : ' (the space after 250 means "I\'m done talking")';
    return ((known && EXTENSIONS[keyword](arg)) || '"Hello!"') + end;
  }
  if ((match = /^2\.1\.0 Sender <(.*)> OK/.exec(text))) return `"Got it: if something goes wrong, I'll send it back to ${match[1] || 'nobody'}."`;
  if ((match = /^2\.1\.5 Recipient <(.+)> OK/.exec(text))) return `"${match[1]} lives here!"`;
  if ((match = /^2\.0\.0 Ok: queued as (\S+)/.exec(text))) return `"Got it! I saved it as number ${match[1]}. Getting it to the person is MY job now."`;
  return '"All good."';
}

/** Prints one "C: ..." or "S: ..." line of the conversation and its explanation. */
export function showSmtp(line: string): void {
  const dir = line.startsWith('C: ') ? 'C' : 'S';
  show(line, explainSmtp(dir, line.slice(3)));
}

// ------------------------------------------------------------------ message headers

/** Explains a "Name: value" header (the name may come in lowercase). */
export function explainHeader(name: string, value: string): string | null {
  const trimmed = value.trim();
  const disguised = /=\?UTF-8\?B\?/i.test(trimmed);
  switch (name.toLowerCase()) {
    case 'return-path':
      return 'the RETURN address that was on the envelope (MAIL FROM). The doorman copied it here on delivery so it doesn\'t get lost';
    case 'received': {
      const match = /from (\S+) by (\S+)/.exec(trimmed);
      return match
        ? `a post office "stamp": ${match[1]} handed it to ${match[2]}. Each stop puts its stamp ON TOP of the others`
        : 'a "stamp" from a post office the letter went through';
    }
    case 'from':
      return 'who the person SEES as the sender. It is written INSIDE the letter and can be different from the envelope!' +
        (disguised ? ' The name has an "é" and an "ë", so it was disguised as =?UTF-8?B?...?= (explained at the Subject below)' : '');
    case 'to': return 'who the letter SAYS it is for. What really decides delivery is the RCPT TO on the envelope';
    case 'cc': return 'who gets a copy, and everyone can see them';
    case 'subject':
      return disguised
        ? 'the subject, "disguised" because it has an accent and a ✓: =?UTF-8?B? means "what follows is base64 of UTF-8 text", and ?= closes it'
        : 'the subject: what shows up in the inbox list';
    case 'date': return 'when the letter was written';
    case 'message-id': return 'the letter\'s "ID card": a name that never repeats anywhere in the world';
    case 'x-entity-ref-id':
      return 'an extra header (made-up ones start with X-). Resend uses this one so Gmail doesn\'t group similar emails into one thread';
    case 'mime-version': return 'says: "this letter follows the MIME rules", which allow accents, HTML and attachments';
    case 'content-type': {
      if (trimmed.startsWith('multipart/mixed')) {
        return 'the letter is a BOX with different things inside (the text and the attachments). The boundary is the "dotted line" between each thing';
      }
      if (trimmed.startsWith('multipart/alternative')) {
        return 'inside the box: the SAME letter written two ways (plain and fancy). The app shows the prettiest one it can';
      }
      if (trimmed.startsWith('text/plain')) return 'this part is plain text, no decoration. charset=utf-8 says which "alphabet" was used';
      if (trimmed.startsWith('text/html')) return 'this part is HTML: the same text, decorated with bold, colors and paragraphs';
      const type = trimmed.split(';')[0];
      const fileName = /name="([^"]+)"/.exec(trimmed)?.[1];
      return `this part is a file of type ${type}${fileName ? `, called ${fileName}` : ''}`;
    }
    case 'content-transfer-encoding':
      if (trimmed === 'quoted-printable') return 'the text goes almost as is; only special letters become =XX ("é" becomes =C3=A9)';
      if (trimmed === 'base64') return 'the file was "translated" into safe letters and numbers so the mail doesn\'t break it';
      return null;
    case 'content-disposition': return 'this is an ATTACHMENT: it shows up with the paperclip, not in the middle of the text';
    default: return null;
  }
}

// ------------------------------------------------------------------ the whole message, line by line

/**
 * Explains a raw message (headers + blank line + MIME body), line by line.
 * Each kind of explanation shows up only the first time, so the same sentence is not repeated.
 */
export function explainMessage(raw: string): Array<[string, string | null]> {
  const out: Array<[string, string | null]> = [];
  const said = new Set<string>();
  const once: Once = (key, text) => (said.has(key) ? null : (said.add(key), text));
  let inHeader = true;

  for (const line of raw.replace(/\r\n$/, '').split('\r\n')) {
    let explanation: string | null = null;
    const header = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (/^--\S+--$/.test(line)) {
      explanation = once('end-boundary', 'the dotted line with "--" at the END: no more parts in this box');
      inHeader = false;
    } else if (/^--\S+$/.test(line)) {
      explanation = once('boundary', 'the "dotted line" (boundary): a new part of the box starts here');
      inHeader = true;
    } else if (line === '') {
      explanation = inHeader ? once('blank', '(empty line) separates the headers from the filling: from here down is the content') : null;
      inHeader = false;
    } else if (inHeader && header) {
      const text = explainHeader(header[1], header[2]);
      explanation = text ? once(`${header[1].toLowerCase()}:${text}`, text) : null;
    } else if (line.startsWith('.')) {
      explanation = once('dot', 'this line starts with a dot. The mail carrier had DOUBLED the dot (..) so the doorman wouldn\'t think it was the end; the doorman removed the extra dot');
    } else if (!inHeader) {
      explanation = explainBodyLine(line, once);
    }
    out.push([line, explanation]);
  }
  return out;
}

/** Returns the text the first time a key shows up, and null after that. */
type Once = (key: string, text: string) => string | null;

/** A line of the body: one explanation for the kind of line and, if it ends in "=", another for the line break. */
function explainBodyLine(line: string, once: Once): string | null {
  const isBase64 = /^[A-Za-z0-9+/]{20,}={0,2}$/.test(line);

  let kind: string | null;
  if (/^<\w/.test(line)) kind = once('html', 'the text in HTML: <p> is a paragraph, <b> is bold');
  else if (/=[0-9A-F]{2}/.test(line)) kind = once('qp', 'see the =C3=A9? It is the "é" in disguise: the old mail system only understands simple letters');
  else if (isBase64) kind = once('b64', 'the attachment translated into base64. It looks like alphabet soup, but the app undoes it and gets the original file back');
  else kind = once('body', 'the text of the letter, what the person reads');

  // in base64 the "=" at the end is padding, not a line break
  const softBreak = !isBase64 && line.endsWith('=')
    ? once('soft', 'the "=" at the END means "this line continues below": a line that is too long gets broken like this')
    : null;

  return kind && softBreak ? `${kind}. And ${softBreak}` : kind ?? softBreak;
}

/** Prints the raw message with the explanation below each important line. */
export function showMessage(raw: string, indent = ''): void {
  for (const [line, explanation] of explainMessage(raw)) show(indent + line, explanation, indent + '   ');
}
