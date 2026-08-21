/** Sender identity policy is a privacy boundary: only a user-authorised domain
 * (and its subdomains) can share image permission or branding. */

import assert from 'node:assert/strict';
import {
  allowImagesFromSender,
  remoteImagesAllowed,
  sameSender,
  senderDomain,
  senderDomains,
  senderProfileFor,
} from '../src/lib/sender.ts';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n    ${error.message.split('\n').slice(0, 5).join('\n    ')}`);
  }
}

const cloudflare = {
  id: 'cloudflare.com',
  name: 'Cloudflare',
  domains: ['cloudflare.com'],
  imageUrl: 'https://assets.example/cloudflare.svg',
  allowRemoteImages: true,
};
const profiles = [cloudflare];
const notices = { name: 'Cloudflare', address: 'updates@notices.cloudflare.com' };
const support = { name: 'Cloudflare Support', address: 'help@cloudflare.com' };
const stranger = { name: 'Cloudflare', address: 'notice@cloudflare.net' };

check('normalises only valid email domains', () => {
  assert.equal(senderDomain(' Updates@NOTICES.Cloudflare.com '), 'notices.cloudflare.com');
  assert.equal(senderDomain('https://cloudflare.com'), null);
  assert.equal(senderDomain('not a domain'), null);
});

check('accepts compact domain lists without duplicates', () => {
  assert.deepEqual(senderDomains('cloudflare.com, cloudflare.net cloudflare.com'), [
    'cloudflare.com',
    'cloudflare.net',
  ]);
});

check('authorised domains include their subdomains, not neighbouring domains', () => {
  assert.equal(senderProfileFor(notices, profiles)?.id, cloudflare.id);
  assert.equal(senderProfileFor(stranger, profiles), null);
});

check('sender equality shares an authorised identity only', () => {
  assert.equal(sameSender(notices, support, profiles), true);
  assert.equal(sameSender(notices, stranger, profiles), false);
});

check('trusted remote images require an explicitly authorised sender', () => {
  const prefs = { remoteImages: 'trusted', senderProfiles: profiles };
  assert.equal(remoteImagesAllowed(prefs, notices), true);
  assert.equal(remoteImagesAllowed(prefs, stranger), false);
});

check('allowing a sender makes the current domain explicit', () => {
  const sender = { name: null, address: 'hello@updates.example.com' };
  assert.deepEqual(allowImagesFromSender(sender, []).map((profile) => profile.domains), [['updates.example.com']]);
});

if (failed) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log(`${passed} sender identity checks passed`);
}
