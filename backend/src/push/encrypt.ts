/**
 * The pure half of Web Push: which endpoints may be contacted, and the
 * RFC 8291 payload encryption. No database or config, so it is testable
 * against the RFC's worked example on its own.
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The push services browsers use. Chrome, Edge-on-Android, Brave, Opera and
 * Samsung Internet use FCM; Firefox uses Mozilla's autopush; Safari on macOS
 * and iOS uses Apple's; Edge on Windows uses WNS.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  '.notify.windows.com',
];

/** True when `endpoint` is an https URL on a known push service. */
export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}

/* ── Payload encryption (RFC 8291, aes128gcm) ─────────────────────────────── */

export function encryptPayload(
  plaintext: Buffer,
  p256dh: string,
  auth: string,
  /** Fixed only by the test, which checks the RFC's own worked example. */
  fixed?: { salt: Buffer; privateKey: Buffer },
): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const salt = fixed?.salt ?? randomBytes(16);
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      authSecret,
      Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
      32,
    ),
  );
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record; no padding.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}
