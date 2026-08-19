/**
 * Mailbox credential encryption.
 *
 * AES-256-GCM with a fresh 12-byte nonce per record. The auth tag is stored
 * separately so a truncated or tampered ciphertext fails loudly at decrypt
 * rather than silently producing garbage that we then send to an IMAP server.
 *
 * Plaintext passwords exist only:
 *   - in the request that creates or verifies an account
 *   - in the sync worker, for the duration of one connection
 * They are never logged, never serialised, and never returned by any endpoint.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;

export interface Sealed {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export function seal(plaintext: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, config.secrets.key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyVersion: config.secrets.keyVersion };
}

export function open(sealed: Sealed): string {
  const decipher = createDecipheriv(ALGO, keyFor(sealed.keyVersion), sealed.nonce);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}

/** Rotation seam: during a key rotation this reads the old key for records that
 *  have not been re-encrypted yet: set SECRET_KEY_V<n> to the retired key,
 *  raise SECRET_KEY_VERSION, and let a background pass re-seal. */
function keyFor(version: number): Buffer {
  if (version === config.secrets.keyVersion) return config.secrets.key;
  const previous = process.env[`SECRET_KEY_V${version}`];
  if (!previous) throw new Error(`No key available for secret_key_version=${version}`);
  const raw = Buffer.from(previous, 'base64');
  if (raw.length !== 32) throw new Error(`SECRET_KEY_V${version} must decode to 32 bytes`);
  return raw;
}

/** Constant-time compare for CSRF tokens and similar. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
