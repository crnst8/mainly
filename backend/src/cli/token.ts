/**
 * API token administration.
 *
 * There is no endpoint for this and there should not be: a credential that
 * grants API access must not be mintable by something already holding API
 * access. Minting requires shell on the host, which is the same bar as creating
 * a user.
 *
 *   node --experimental-strip-types src/cli/token.ts create <email> <name> [--scopes read,write] [--days 90]
 *   node --experimental-strip-types src/cli/token.ts list   <email>
 *   node --experimental-strip-types src/cli/token.ts revoke <email> <id>
 *
 * From the repository root: `./dev.sh token create <email> <name>` in
 * development, `./mainly.sh token create <email> <name>` against an install.
 */

import { one } from '../db/index.ts';
import { pool } from '../db/index.ts';
import { createToken, isTokenScope, listTokens, revokeToken, TOKEN_SCOPES } from '../modules/auth/tokens.ts';
import type { TokenScope } from '../modules/auth/tokens.ts';

const USAGE = `usage:
  token create <email> <name> [--scopes read,write,unsubscribe,provision] [--days 90]
  token list   <email>
  token revoke <email> <token-id>

scopes:
  read         search, read messages, list accounts and folders
  write        flag, label, move, archive, trash, snooze
  unsubscribe  act on List-Unsubscribe (implies nothing else)
  provision    create and remove addresses on a connected mail server`;

/** `--key value` and `--key=value`, both. Positionals come back in order. */
function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else flags.set(arg.slice(2), argv[++i] ?? '');
  }
  return { positional, flags };
}

async function userIdFor(email: string): Promise<string> {
  const row = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!row) throw new Error(`No user with the address ${email}`);
  return row.id;
}

const never = 'never';

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, email, third] = positional;

  if (!command || !email) throw new Error(USAGE);
  const userId = await userIdFor(email);

  switch (command) {
    case 'create': {
      if (!third) throw new Error('A name is required, so a token can be identified later.\n\n' + USAGE);

      const requested = (flags.get('scopes') ?? 'read,write').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((s) => !isTokenScope(s));
      if (unknown.length) {
        throw new Error(`Unknown scope(s): ${unknown.join(', ')}. Valid: ${TOKEN_SCOPES.join(', ')}`);
      }

      const daysRaw = flags.get('days');
      // No expiry is allowed and is the wrong default. A token minted for one
      // experiment outlives the experiment unless something ends it.
      const expiresInDays = daysRaw === undefined ? 90 : daysRaw === never ? null : Number(daysRaw);
      if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1)) {
        throw new Error(`--days must be a positive whole number of days, or "${never}"`);
      }

      const { token, record } = await createToken({
        userId,
        name: third,
        scopes: requested as TokenScope[],
        expiresInDays,
      });

      // The only time this string exists outside the caller's memory. Printed
      // to stdout alone so it can be piped into a config file without the
      // surrounding prose coming with it.
      console.error(`\ntoken "${record.name}" for ${email}`);
      console.error(`scopes:  ${record.scopes.join(', ')}`);
      console.error(`expires: ${record.expiresAt ?? never}`);
      console.error('\nThis is shown once. It is not recoverable.\n');
      console.log(token);
      console.error('');
      break;
    }

    case 'list': {
      const tokens = await listTokens(userId);
      if (!tokens.length) {
        console.log(`no tokens for ${email}`);
        break;
      }
      for (const t of tokens) {
        const used = t.lastUsedAt ? `last used ${t.lastUsedAt}` : 'never used';
        console.log(
          `${t.id}  ${t.prefix}…  ${t.name}\n` +
            `  scopes ${t.scopes.join(', ') || 'none'} · expires ${t.expiresAt ?? never} · ${used}`,
        );
      }
      break;
    }

    case 'revoke': {
      if (!third) throw new Error('A token id is required. Run `token list <email>` to find it.');
      const gone = await revokeToken(userId, third);
      console.log(gone ? `revoked ${third}` : `no such token for ${email}: ${third}`);
      if (!gone) process.exitCode = 1;
      break;
    }

    default:
      throw new Error(USAGE);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err: Error) => {
    console.error(err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
