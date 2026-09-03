/**
 * Domain control administration.
 *
 * Connecting a domain means handing this install an SSH key, so it is done from
 * a shell on the host rather than through the API — the same bar `token` sets,
 * and for the same reason: a credential that widens what the application can do
 * must not be installable by something that already holds API access.
 *
 *   node --experimental-strip-types src/cli/domain.ts list <email>
 *   node --experimental-strip-types src/cli/domain.ts add <email> <domain> --host h --key ./id_ed25519
 *   node --experimental-strip-types src/cli/domain.ts grant <email> <domain> list,create
 *   node --experimental-strip-types src/cli/domain.ts probe <email> <domain>
 *
 * From the repository root: `./mainly.sh domain …` against an install,
 * `./dev.sh domain …` in development.
 */

import { readFile } from 'node:fs/promises';
import { one, pool } from '../db/index.ts';
import { DOMAIN_GRANTS, DOMAIN_GRANT_LABELS, isDomainGrant } from '../contract/types.ts';
import {
  connectDomain,
  createMailbox,
  disconnectDomain,
  listDomains,
  listMailboxes,
  listOps,
  probeDomain,
  readHostKey,
  removeMailbox,
  updateDomain,
} from '../modules/domains/service.ts';

const USAGE = `usage:
  domain list      <email>
  domain add       <email> <domain> --host <host> --key <path> [--user mailprov] [--port 22]
  domain grant     <email> <domain> <list,create,…>   replaces the whole set
  domain probe     <email> <domain>
  domain mailboxes <email> <domain>
  domain create    <email> <address>                  password on stdin, or generated
  domain delete    <email> <address> [--purge]
  domain forget    <email> <domain>                   app-side only; touches no mail
  domain ops       <email> [--limit 50]
  domain hostkey   --host <host> [--port 22]

grants:
${DOMAIN_GRANTS.map((g) => `  ${g.padEnd(12)} ${DOMAIN_GRANT_LABELS[g]}`).join('\n')}

A domain starts with none of them. What the mail server itself permits is set
in /etc/mainly-provision.conf on that machine, and this cannot widen it.`;

/** `--key value` and `--key=value`, both. Positionals come back in order.
 *  Lifted from cli/token.ts — the two commands should parse identically. */
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
    else if (argv[i + 1] === undefined || argv[i + 1]!.startsWith('--')) flags.set(arg.slice(2), 'true');
    else flags.set(arg.slice(2), argv[++i]!);
  }
  return { positional, flags };
}

async function userIdFor(email: string): Promise<string> {
  const row = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!row) throw new Error(`No user with the address ${email}`);
  return row.id;
}

async function domainIdFor(userId: string, domain: string): Promise<string> {
  const domains = await listDomains(userId);
  const match = domains.find((d) => d.domain === domain.toLowerCase());
  if (!match) throw new Error(`${domain} is not connected. Run \`domain list\` to see what is.`);
  return match.id;
}

/** Read a password from stdin when one is piped in. Interactive callers get a
 *  generated one instead — a prompt that echoes is worse than a strong
 *  password printed once, on purpose, to a terminal the operator is watching. */
async function passwordFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const value = Buffer.concat(chunks).toString('utf8').split('\n')[0]!.trim();
  return value || null;
}

const generatePassword = (): string => {
  // Unambiguous alphabet: no l/I/1, no O/0. These get read off a screen and
  // typed into a phone's mail settings.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

function splitAddress(address: string): { localpart: string; domain: string } {
  const [localpart, domain] = address.trim().toLowerCase().split('@');
  if (!localpart || !domain) throw new Error(`'${address}' is not an address. Use user@domain.`);
  return { localpart, domain };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, email, third] = positional;

  if (!command) throw new Error(USAGE);

  // The only command that needs no user: it reads a public key from a host.
  if (command === 'hostkey') {
    const host = flags.get('host');
    if (!host) throw new Error('--host is required');
    const key = await readHostKey(host, Number(flags.get('port') ?? 22));
    console.error(`host key for ${host}:`);
    console.log(key);
    return;
  }

  if (!email) throw new Error(USAGE);
  const userId = await userIdFor(email);

  switch (command) {
    case 'list': {
      const domains = await listDomains(userId);
      if (!domains.length) {
        console.log(`no domains connected for ${email}`);
        break;
      }
      for (const d of domains) {
        const checked = d.lastCheckedAt ? `checked ${d.lastCheckedAt}` : 'never checked';
        console.log(
          `${d.domain}  [${d.status}]  ${d.driver}://${d.config.user}@${d.config.host}:${d.config.port}\n` +
            `  granted here  ${d.grants.join(', ') || 'nothing'}\n` +
            `  server allows ${d.serverGrants.join(', ') || 'unknown — run `domain probe`'}\n` +
            `  in effect     ${d.effective.join(', ') || 'nothing'}\n` +
            `  ${checked}${d.error ? `\n  error: ${d.error}` : ''}`,
        );
      }
      break;
    }

    case 'add': {
      if (!third) throw new Error('A domain is required.\n\n' + USAGE);
      const host = flags.get('host');
      const keyPath = flags.get('key');
      if (!host || !keyPath) throw new Error('--host and --key are both required.');

      const privateKey = await readFile(keyPath, 'utf8');

      // Pinned at connect time rather than trusted on first use. If the
      // operator did not supply one, read it now and show it — the fingerprint
      // is meant to be compared against `ssh-keygen -lf` on the mail host.
      let hostKey = flags.get('hostkey') ?? null;
      const port = Number(flags.get('port') ?? 22);
      if (!hostKey) {
        hostKey = await readHostKey(host, port);
        console.error(`pinned host key: ${hostKey}`);
        console.error(`verify with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub  (on ${host})\n`);
      }

      const created = await connectDomain(userId, {
        domain: third,
        driver: flags.get('driver') ?? 'ssh',
        host,
        port,
        user: flags.get('user'),
        hostKey,
        privateKey,
      });
      console.log(`connected ${created.domain} (${created.id})`);
      console.log('It can do nothing yet. Grant something:');
      console.log(`  domain grant ${email} ${created.domain} list,create`);
      break;
    }

    case 'grant': {
      if (!third) throw new Error('A domain is required.\n\n' + USAGE);
      const raw = positional[3] ?? '';
      const grants = raw.split(',').map((g) => g.trim()).filter(Boolean);
      const unknown = grants.filter((g) => !isDomainGrant(g));
      if (unknown.length) {
        throw new Error(`Unknown grant(s): ${unknown.join(', ')}. Valid: ${DOMAIN_GRANTS.join(', ')}`);
      }
      const id = await domainIdFor(userId, third);
      const updated = await updateDomain(userId, id, { grants });
      console.log(`${updated.domain} granted: ${updated.grants.join(', ') || 'nothing'}`);
      if (updated.status === 'pending') console.log('Run `domain probe` to see what the server allows.');
      else console.log(`in effect: ${updated.effective.join(', ') || 'nothing'}`);
      break;
    }

    case 'probe': {
      if (!third) throw new Error('A domain is required.\n\n' + USAGE);
      const id = await domainIdFor(userId, third);
      const result = await probeDomain(userId, id, { kind: 'session' });
      console.log(`${third}: ${result.status}`);
      if (result.error) console.log(`  ${result.error}`);
      else {
        console.log(`  postfix ${result.postfix ?? '?'} · dovecot ${result.dovecot ?? '?'}`);
        console.log(`  server allows: ${result.serverGrants.join(', ') || 'nothing for this domain'}`);
        if (!result.parity) {
          console.log('  WARNING: the server\'s maps disagree with each other. Provisioning will');
          console.log('  refuse to run until that is fixed — see docs/domain-control.md.');
        }
      }
      break;
    }

    case 'mailboxes': {
      if (!third) throw new Error('A domain is required.\n\n' + USAGE);
      const id = await domainIdFor(userId, third);
      const boxes = await listMailboxes(userId, id);
      if (!boxes.length) console.log(`no mailboxes on ${third}`);
      for (const b of boxes) console.log(`${b.linked ? '*' : ' '} ${b.address}`);
      if (boxes.some((b) => b.linked)) console.log('\n* already synced by this install');
      break;
    }

    case 'create': {
      if (!third) throw new Error('An address is required.\n\n' + USAGE);
      const { localpart, domain } = splitAddress(third);
      const id = await domainIdFor(userId, domain);
      const supplied = await passwordFromStdin();
      const password = supplied ?? generatePassword();
      await createMailbox(userId, id, { localpart, password }, { kind: 'session' });
      console.error(`created ${localpart}@${domain}`);
      if (!supplied) {
        console.error('password (shown once):');
        console.log(password);
      }
      break;
    }

    case 'delete': {
      if (!third) throw new Error('An address is required.\n\n' + USAGE);
      const { localpart, domain } = splitAddress(third);
      const id = await domainIdFor(userId, domain);
      const purge = flags.get('purge') === 'true';
      await removeMailbox(userId, id, { localpart, purge }, { kind: 'session' });
      console.log(
        purge
          ? `deleted ${localpart}@${domain} and destroyed its stored mail`
          : `deleted ${localpart}@${domain}; its mail is still on the server`,
      );
      break;
    }

    case 'forget': {
      if (!third) throw new Error('A domain is required.\n\n' + USAGE);
      const id = await domainIdFor(userId, third);
      await disconnectDomain(userId, id);
      console.log(`forgot ${third}. No address and no mail was touched.`);
      break;
    }

    case 'ops': {
      const ops = await listOps(userId, Number(flags.get('limit') ?? 50));
      if (!ops.length) console.log('nothing recorded yet');
      for (const o of ops) {
        console.log(
          `${o.createdAt}  ${o.status === 'ok' ? 'ok    ' : 'FAILED'}  ${o.action.padEnd(12)} ` +
            `${o.target}  (${o.actor})${o.detail ? `\n  ${o.detail}` : ''}`,
        );
      }
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
