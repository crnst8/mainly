/**
 * Web Push, the sending half. RFC 8030 delivery, RFC 8291 payload encryption,
 * RFC 8292 (VAPID) server identification.
 *
 * Written against `node:crypto` rather than pulled in as a package: the whole
 * protocol is one ECDH, two HKDF expansions, one AES-GCM seal and one ES256
 * signature, and the dependency list is deliberately short.
 *
 * The push service never sees the payload. It is encrypted to the browser's own
 * key, so the sender, subject and preview in a notification are readable only
 * on the device that subscribed.
 *
 * Request forgery: the endpoint is a URL the browser handed us and the server
 * then POSTs to. It is only accepted, and only contacted, when its host belongs
 * to a known browser push service — see `PUSH_HOSTS` in encrypt.ts.
 */

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { one, query } from '../db/index.ts';
import { config } from '../config.ts';
import { open, seal } from '../lib/crypto.ts';
import { encryptPayload, isPushEndpoint } from './encrypt.ts';

/* ── VAPID keys ────────────────────────────────────────────────────────────── */

interface VapidKeys {
  /** Uncompressed P-256 point, base64url. What the browser subscribes with. */
  publicKey: string;
  privateJwk: { kty: string; crv: string; x: string; y: string; d: string };
}

let cached: VapidKeys | null = null;

/** The install's key pair, made on first use. */
export async function vapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  const row = await one<{
    public_key: string;
    secret_ciphertext: Buffer;
    secret_nonce: Buffer;
    secret_tag: Buffer;
    secret_key_version: number;
  }>('SELECT * FROM push_vapid WHERE id = 1');
  if (row) {
    cached = {
      publicKey: row.public_key,
      privateJwk: JSON.parse(
        open({
          ciphertext: row.secret_ciphertext,
          nonce: row.secret_nonce,
          tag: row.secret_tag,
          keyVersion: row.secret_key_version,
        }),
      ),
    };
    return cached;
  }

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as VapidKeys['privateJwk'];
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  const sealed = seal(JSON.stringify(jwk));
  // Two processes racing on first use must agree on one pair; whichever
  // insert lands is the pair, and the loser reads it back.
  await query(
    `INSERT INTO push_vapid (id, public_key, secret_ciphertext, secret_nonce, secret_tag, secret_key_version)
     VALUES (1, $1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [publicKey, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyVersion],
  );
  return vapidKeys();
}

/** `sub` must be a mailto: or https: URL; Apple refuses anything else. */
function subject(): string {
  try {
    const origin = new URL(config.appOrigin);
    if (origin.protocol === 'https:') return origin.origin;
    return `mailto:postmaster@${origin.hostname.includes('.') ? origin.hostname : 'localhost.localdomain'}`;
  } catch {
    return 'mailto:postmaster@localhost.localdomain';
  }
}

function vapidHeader(endpoint: string, keys: VapidKeys): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject(),
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/* ── Delivery ──────────────────────────────────────────────────────────────── */

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** A newer message with the same topic replaces an undelivered older one. */
  topic?: string;
}

/**
 * Send one payload to one device. Resolves to `gone` when the push service says
 * the subscription no longer exists, which the caller deletes; any other
 * failure is logged and dropped, because a notification retried minutes later
 * is worse than none.
 */
export async function deliver(
  target: PushTarget,
  payload: object,
  options: PushOptions,
): Promise<'sent' | 'gone' | 'failed'> {
  if (!isPushEndpoint(target.endpoint)) return 'gone';
  const keys = await vapidKeys();
  const headers: Record<string, string> = {
    authorization: vapidHeader(target.endpoint, keys),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(options.ttl),
    urgency: options.urgency,
  };
  if (options.topic) headers.topic = options.topic;
  try {
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers,
      body: encryptPayload(Buffer.from(JSON.stringify(payload)), target.p256dh, target.auth),
      // A push service has no reason to redirect, and following one would let
      // the endpoint's host choose where this server sends requests.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) {
      console.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'push refused');
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn({ err: (err as Error).message }, 'push delivery failed');
    return 'failed';
  }
}
