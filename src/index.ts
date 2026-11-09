// Public API: everything an app needs to send, route and read email with mini-mta.
// The fakes in src/testing/ are left out on purpose: they exist for tests and examples.
export { startSmtpServer, type Envelope, type ServerOptions, type SmtpServer, type Stored } from './smtp/server.ts';
export { dotStuff, isPermanent, sendMail, type Rejected, type SendInput, type SendResult, type Stage } from './smtp/client.ts';
export { connect, type Reply, type Wire } from './smtp/wire.ts';
export { decodeQP, decodeWords, encodeQP, encodeWord, base64Lines } from './mime/encoding.ts';
export { buildMessage, envelopeOf, type Attachment, type MailInput } from './mime/message.ts';
export { describe, parseMessage, pickAlternative, type ParsedMail, type Part } from './mime/parse.ts';
export { makeResolver, mxRoute, type MxHost, type MxRoute } from './delivery/mx.ts';
export { deliver, type MtaOptions, type Outcome } from './delivery/mta.ts';
