/**
 * Mailbox credential encryption.
 *
 * AES-256-GCM with a fresh 12-byte nonce and separately stored auth tag.
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

/** Resolve the current or retained key for a sealed credential. */
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
