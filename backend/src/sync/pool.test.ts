import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import test from 'node:test';

process.env.DATABASE_URL = 'postgres://pool-test/none';
process.env.SECRET_KEY = Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET = 'pool-test';
const { seal } = await import('../lib/crypto.ts');
const { connect } = await import('./pool.ts');

// A server that greets, then resets the socket on the first command: the
// ECONNRESET a mail server or a middlebox can produce at any time.
test('a connection reset rejects the call instead of crashing the process', async (t) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.write('* OK ready\r\n');
    socket.once('data', () => socket.resetAndDestroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  t.mock.method(console, 'warn', () => {});

  const port = (server.address() as { port: number }).port;
  const sealed = seal('not-a-real-password');
  await assert.rejects(
    connect({
      id: 'pool-test',
      address: 'a@example.test',
      imapHost: '127.0.0.1',
      imapPort: port,
      imapSecurity: 'none',
      username: 'a@example.test',
      secretCiphertext: sealed.ciphertext,
      secretNonce: sealed.nonce,
      secretTag: sealed.tag,
      secretKeyVersion: sealed.keyVersion,
    }),
  );
  // An unhandled 'error' event would have thrown on a later tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
});
