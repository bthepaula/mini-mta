// The MIME encodings: they turn any byte (accents, emojis, PDFs) into short ASCII lines.
// quoted-printable (RFC 2045 6.7) for text, base64 (6.8) for binary, encoded-word (RFC 2047) for headers.

const hex = (b: number) => '=' + b.toString(16).toUpperCase().padStart(2, '0');

// Mostly ASCII text stays readable; only the "strange" bytes become =XX. Lines of at most 76.
export function encodeQP(text: string): string {
  return text.replace(/\r?\n/g, '\n').split('\n').map(encodeQPLine).join('\r\n');
}

function encodeQPLine(line: string): string {
  const bytes = [...Buffer.from(line, 'utf8')];
  const out: string[] = [];
  let current = '';
  bytes.forEach((b, i) => {
    const printable = b >= 33 && b <= 126 && b !== 61; // "=" (61) is the escape character itself
    const innerSpace = (b === 32 || b === 9) && i < bytes.length - 1; // a space at the end of a line becomes =20
    const token = printable || innerSpace ? String.fromCharCode(b) : hex(b);
    if (current.length + token.length > 75) { // "soft" line break: "=" at the end means "continues below"
      out.push(current + '=');
      current = '';
    }
    current += token;
  });
  return [...out, current].join('\r\n');
}

export function decodeQP(encoded: string): string {
  const s = encoded.replace(/=\r?\n/g, ''); // undoes the soft line breaks
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');
}

// base64 in lines of 76 characters: 3 bytes become 4 characters (+33%), plus the CRLF of each line
export function base64Lines(content: Buffer): string {
  return (content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

// "Order confirmed ✓" in a header: =?UTF-8?B?...?=. Up to 39 bytes per word: with "Subject: " in front, the line stays under 76
export function encodeWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value; // printable ASCII: stays as it is
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) { // per character, so a UTF-8 character is never split in half
    if (Buffer.byteLength(chunk + ch) > 39) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  words.push(chunk);
  // words separated by CRLF + space (folding); the reader ignores the space between encoded-words
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2') // a space between two encoded-words doesn't count
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, enc: string, text: string) =>
      enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64').toString('utf8') : decodeQP(text.replace(/_/g, ' ')));
}
