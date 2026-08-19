/**
 * API tokens — the credential an agent uses.
 *
 * A session cookie is the wrong shape for this. It is httpOnly by design, it is
 * paired with a CSRF token that only a browser can echo, and it belongs to a
 * person who is present. An MCP server running under OpenCode is none of those
 * things: it is a long-lived process, it holds its credential in a file, and
 * nobody is watching it.
 *
 * So: a bearer token, scoped, revocable, and hashed at rest.
 *
 * **No CSRF check applies to a bearer token, and that is correct rather than an
 * omission.** CSRF exists because a cookie is *ambient* — the browser attaches
 * it to a request the page did not intend to make. A token in an `Authorization`
 * header is never attached by anything but the code that holds it, so there is
 * no confused deputy to defend against. Skipping the check for cookies would be
 * a hole; skipping it here is the definition.
 *
 * Hashing is SHA-256, not argon2, and that is also deliberate. A password is
 * low-entropy and needs a slow KDF to survive an offline attack. This is 256
 * bits from `randomBytes`; there is no dictionary, and every request would pay
 * the KDF cost for nothing.
 */

import { createHash, randomBytes } from 'node:crypto';
import { one, query } from '../../db/index.ts';

/**
 * What a token is allowed to do.
 *
 * Three, not thirty. A scope nobody can explain in one line is a scope nobody
 * sets correctly.
 */
export type TokenScope = 'read' | 'write' | 'unsubscribe';

export const TOKEN_SCOPES: TokenScope[] = ['read', 'write', 'unsubscribe'];

export const isTokenScope = (v: string): v is TokenScope =>
  (TOKEN_SCOPES as string[]).includes(v);

/** Distinctive enough to be greppable in a log that should never contain it,
 *  and to be recognisable when it is pasted into the wrong box. */
const PREFIX = 'mailt_';

export interface TokenRecord {
  id: string;
  userId: string;
  name: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** The visible fragment. Never enough to authenticate with. */
  prefix: string;
}

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  prefix: string;
}

const toRecord = (r: TokenRow): TokenRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  scopes: r.scopes.filter(isTokenScope),
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  expiresAt: r.expires_at?.toISOString() ?? null,
  prefix: r.prefix,
});

/**
 * Mint a token.
 *
 * Returns the secret exactly once. There is no endpoint and no query that can
 * produce it again, which is the point — a token that can be re-read is a
 * token that can be stolen from the place it is re-read from.
 */
export async function createToken(input: {
  userId: string;
  name: string;
  scopes: TokenScope[];
  expiresInDays: number | null;
}): Promise<{ token: string; record: TokenRecord }> {
  const secret = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const row = await one<TokenRow>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[],
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() + ($6::int || ' days')::interval END)
     RETURNING id, user_id, name, scopes, created_at, last_used_at, expires_at, prefix`,
    [
      input.userId,
      input.name,
      digest(secret),
      // Enough to tell two tokens apart, far too little to guess the rest.
      secret.slice(0, PREFIX.length + 6),
      input.scopes,
      input.expiresInDays,
    ],
  );
  return { token: secret, record: toRecord(row!) };
}

/**
 * Resolve a presented token, or null.
 *
 * `last_used_at` is written on every successful resolve. It is one cheap UPDATE
 * on a table with as many rows as the operator has agents, and it is the only
 * way to answer "is anything still using this token" before revoking it.
 */
export async function resolveToken(presented: string): Promise<TokenRecord | null> {
  if (!presented.startsWith(PREFIX)) return null;
  const row = await one<TokenRow>(
    `UPDATE api_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, user_id, name, scopes, created_at, last_used_at, expires_at, prefix`,
    [digest(presented)],
  );
  return row ? toRecord(row) : null;
}

export async function listTokens(userId: string): Promise<TokenRecord[]> {
  const rows = await query<TokenRow>(
    `SELECT id, user_id, name, scopes, created_at, last_used_at, expires_at, prefix
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toRecord);
}

/** True when a token was there to revoke. */
export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM api_tokens WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, id],
  );
  return rows.length > 0;
}
