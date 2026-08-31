/**
 * The SSRF guard, tested as a table of spellings.
 *
 * Every case below was a real bypass of the code this replaced: the mail-server
 * path matched hostnames as text, so `2130706433` and `localtest.me` walked
 * through it, and the unsubscribe path's v6 handling was string prefixes, so
 * `0:0:0:0:0:0:0:1` did too. The table is the point — one destination has many
 * spellings, and a guard is only worth having if it answers the same for all of
 * them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isPrivateAddress } from './ip.ts';

test('refuses every private and reserved v4 range', () => {
  for (const ip of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255',
    '192.0.0.1', '192.0.2.7', '192.88.99.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.4', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
  }
});

test('allows ordinary public v4, including the near-misses', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    // One outside each neighbouring block, so the bounds are not off by one.
    '9.255.255.255', '11.0.0.1', '172.15.0.1', '172.32.0.1', '192.167.0.1',
    '192.169.0.1', '99.255.255.255', '128.0.0.1', '223.255.255.255',
  ]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed`);
  }
});

test('refuses loopback however it is spelled in v6', () => {
  for (const ip of [
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::0001',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} is loopback and must be refused`);
  }
});

test('refuses the rest of the v6 ranges, and what they wrap', () => {
  for (const ip of [
    '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '100::1',
    '2001:db8::1',
    // v4-mapped and NAT64 are judged on the address they carry.
    '::ffff:10.0.0.1', '::ffff:192.168.1.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1',
    // 6to4 carries its v4 in the two groups after the prefix.
    '2002:7f00:0001::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
  }
});

test('allows public v6, including wrappers around public v4', () => {
  for (const ip of [
    '2606:4700:4700::1111', '2a00:1450:4001::1', '::ffff:8.8.8.8', '2002:5db8:d822::1',
  ]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed`);
  }
});

test('treats anything it cannot parse as private', () => {
  // Failing open on unrecognised input is a hole shaped like that input.
  for (const junk of ['', 'not-an-address', '999.1.1.1', '::gggg', '127.0.0', '1.2.3.4.5']) {
    assert.equal(isPrivateAddress(junk), true, `${JSON.stringify(junk)} must not pass`);
  }
});
