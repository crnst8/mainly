/**
 * Mail hook administration.
 *
 * No endpoint, for the same reason as agent tokens: a credential that makes
 * this install act must not be mintable by something already talking to it.
 * Normally run for you by `./mainly.sh hook connect` (scripts/connect-mailhook.sh).
 *
 *   hook create <imap-host> [<imap-host>…] [--replace]   prints the token, once
 *   hook list
 *   hook remove <id | imap-host>
 *   hook hosts                    IMAP hosts accounts here use
 *   hook login <imap-host>…       one login on those hosts, for the installer's test
 *   hook last <imap-host>         last notice from that host's hook, epoch ms or 0
 *
 * See docs/mail-hook.md.
 */

import { pool } from '../db/index.ts';
import {
  accountHosts,
  createHook,
  listHooks,
  loginOn,
  removeHooks,
} from '../modules/hooks/service.ts';

const USAGE = `usage:
  hook create <imap-host> [<imap-host>…] [--replace]
  hook list
  hook remove <id | imap-host>
  hook hosts
  hook login <imap-host> [<imap-host>…]
  hook last <imap-host>`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const [command, ...rest] = args.filter((a) => a !== '--replace');

  switch (command) {
    case 'create': {
      if (!rest.length) throw new Error(USAGE);
      const { token, record } = await createHook(rest, { replace });
      // Prose to stderr, the token alone to stdout, so it can be piped.
      console.error(`hook ${record.id} for ${record.hosts.join(', ')}`);
      console.error('This is shown once. It is not recoverable.');
      console.log(token);
      break;
    }

    case 'list': {
      const hooks = await listHooks();
      if (!hooks.length) {
        console.log('no mail hooks');
        break;
      }
      for (const h of hooks) {
        console.log(
          `${h.id}  ${h.prefix}…  ${h.hosts.join(', ')}\n` +
            `  created ${h.createdAt} · ${h.lastEventAt ? `last notice ${h.lastEventAt}` : 'no notice yet'}`,
        );
      }
      break;
    }

    case 'remove': {
      if (!rest[0]) throw new Error(USAGE);
      const n = await removeHooks(rest[0]);
      console.log(n ? `removed ${n} hook${n === 1 ? '' : 's'}` : `no hook matches ${rest[0]}`);
      if (!n) process.exitCode = 1;
      break;
    }

    case 'hosts': {
      for (const { host, accounts } of await accountHosts()) console.log(`${host} ${accounts}`);
      break;
    }

    case 'login': {
      if (!rest.length) throw new Error(USAGE);
      const login = await loginOn(rest);
      if (!login) throw new Error(`No working account on ${rest.join(', ')}`);
      console.log(login);
      break;
    }

    case 'last': {
      if (!rest[0]) throw new Error(USAGE);
      const host = rest[0].toLowerCase();
      const hook = (await listHooks()).find((h) => h.hosts.includes(host));
      console.log(hook?.lastEventAt ? String(Date.parse(hook.lastEventAt)) : '0');
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
