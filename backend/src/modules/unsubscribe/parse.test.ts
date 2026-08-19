import assert from 'node:assert/strict';
import test from 'node:test';
import { isOneClick, isPrivateAddress, parseListUnsubscribe } from './parse.ts';

test('reads a well-formed List-Unsubscribe in the sender’s order', () => {
  assert.deepEqual(
    parseListUnsubscribe('<https://list.example/u/9>, <mailto:stop@list.example?subject=unsub>'),
    [
      { method: 'http', target: 'https://list.example/u/9' },
      { method: 'mailto', target: 'mailto:stop@list.example?subject=unsub' },
    ],
  );
});

test('survives the ways real senders write it wrong', () => {
  // No brackets at all.
  assert.deepEqual(parseListUnsubscribe('mailto:stop@x.test'), [
    { method: 'mailto', target: 'mailto:stop@x.test' },
  ]);
  // Whitespace and newlines from a folded header.
  assert.deepEqual(parseListUnsubscribe('< https://x.test/u >'), [
    { method: 'http', target: 'https://x.test/u' },
  ]);
  // Uppercase scheme.
  assert.deepEqual(parseListUnsubscribe('<MAILTO:stop@x.test>'), [
    { method: 'mailto', target: 'MAILTO:stop@x.test' },
  ]);
});

test('drops anything that is not a scheme we can act on, and never throws', () => {
  assert.deepEqual(parseListUnsubscribe(undefined), []);
  assert.deepEqual(parseListUnsubscribe(''), []);
  assert.deepEqual(parseListUnsubscribe('<>'), []);
  assert.deepEqual(parseListUnsubscribe('unsubscribe by replying'), []);
  assert.deepEqual(parseListUnsubscribe('<tel:+61000>, <javascript:alert(1)>'), []);
  // A truncated URL is not a URL.
  assert.deepEqual(parseListUnsubscribe('<http'), []);
  // One bad entry must not take the good one with it.
  assert.deepEqual(parseListUnsubscribe('<ftp://x.test>, <https://x.test/u>'), [
    { method: 'http', target: 'https://x.test/u' },
  ]);
});

test('one-click is recognised only when the sender actually declared it', () => {
  assert.equal(isOneClick('List-Unsubscribe=One-Click'), true);
  assert.equal(isOneClick('list-unsubscribe = one-click'), true);
  assert.equal(isOneClick(undefined), false);
  assert.equal(isOneClick(''), false);
  // The header exists but says something else. Not a licence to POST.
  assert.equal(isOneClick('List-Unsubscribe=Two-Click'), false);
});

test('every address an unsubscribe link must not reach is rejected', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata, the one that matters most
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1', // v4-mapped loopback
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('ordinary public addresses are allowed through', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});
