/**
 * Domain control administration — the mainly half.
 *
 * The other half runs on the mail server. `mainly-provision setup` there does
 * everything that machine needs and prints one line to paste here:
 *
 *   ./mainly.sh domain connect <string>
 *
 * That string carries the address, the port, the account, the mail server's own
 * host key fingerprints, the domains it agreed to, and a freshly minted private
 * key. Pasting it is the whole of the setup on this side — the connection is
 * made, the host key is checked against what the server said its own keys are,
 * every domain is connected, and each is granted whatever that server permits.
 *
 * Handing this install an SSH key is why this is a shell command and not an API
 * call, the same bar `token` sets, and for the same reason: a credential that
 * widens what the application can do must not be installable by something that
 * already holds API access.
 *
 * From the repository root: `./mainly.sh domain …` against an install,
 * `./dev.sh domain …` in development.
 */

import { createInterface } from 'node:readline';
import { one, pool, query } from '../db/index.ts';
import {
  DOMAIN_GRANTS,
  DOMAIN_GRANT_LABELS,
  isDomainGrant,
  type DomainGrant,
  type ManagedDomain,
} from '../contract/types.ts';
import {
  attachDomain,
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

const line = (cmd: string, what: string) => `  ${cmd.padEnd(30)}${what}`;

const USAGE = [
  'usage:',
  '',
  line('domain connect <string>', 'paste what `mainly-provision setup` printed'),
  line('domain status', 'what is connected, and what it may do'),
  line('domain doctor', 'check every layer, name the broken one'),
  '',
  line('domain add <domain>', 'another domain on a server already connected'),
  line('domain addresses [domain]', 'what exists on the mail server'),
  line('domain new <address>', 'create one. Password on stdin, or generated'),
  line('domain rm <address> [--purge]', 'remove one. --purge also destroys its mail'),
  line('domain scope [domain] <what>', 'full, keep, read, or a comma-separated list'),
  line('domain history [--limit 50]', 'every attempt to change that mail server'),
  line('domain forget [domain]', 'drop the key here. No address, no mail'),
  '',
  'Your login address is not an argument — it is inferred, and so is the domain',
  'when only one is connected. Say which only when it is ambiguous: `--as',
  'you@example.com`, and the domain by name.',
  '',
  'Setup, start to finish:',
  '',
  '  On the mail server   sudo mainly-provision setup',
  '  Here                 ./mainly.sh domain connect <the string it printed>',
].join('\n');

const SCOPES: Record<string, DomainGrant[]> = {
  full: ['list', 'create', 'delete', 'password', 'alias', 'purge'],
  keep: ['list', 'create', 'delete', 'password', 'alias'],
  read: ['list'],
  none: [],
};

/* ── Output ──────────────────────────────────────────────────────────────── */

// Everything the operator reads goes to stderr, so the one thing a script would
// want to capture — a generated password, a host key — is the only thing on
// stdout. `domain new … | pbcopy` has to mean the password and nothing else.
const tty = process.stderr.isTTY;
const B = tty ? '\x1b[1m' : '';
const D = tty ? '\x1b[2m' : '';
const R = tty ? '\x1b[0m' : '';
const GR = tty ? '\x1b[32m' : '';
const RD = tty ? '\x1b[31m' : '';
const YL = tty ? '\x1b[33m' : '';

const say = (s = '') => console.error(s);
const hdr = (s: string) => console.error(`\n${B}${s}${R}`);
const good = (s: string) => console.error(`  ${GR}✓${R} ${s}`);
const bad = (s: string) => console.error(`  ${RD}✗${R} ${s}`);
const huh = (s: string) => console.error(`  ${YL}!${R} ${s}`);
const note = (s: string) => console.error(`     ${D}${s}${R}`);

/* ── Arguments ───────────────────────────────────────────────────────────── */

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

/**
 * Whose domains these are.
 *
 * This used to be a required positional on every subcommand, which made the
 * commonest invocation `domain probe you@example.com example.com` — two
 * arguments to say one thing, on an install that has exactly one account. It is
 * now inferred, and only has to be given when the inference is genuinely
 * ambiguous.
 */
async function resolveUser(flags: Map<string, string>): Promise<{ id: string; email: string }> {
  const wanted = flags.get('as') ?? process.env.MAINLY_USER;
  if (wanted) {
    const row = await one<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE email = $1',
      [wanted],
    );
    if (!row) throw new Error(`No account here with the address ${wanted}.`);
    return row;
  }
  const rows = await query<{ id: string; email: string }>(
    'SELECT id, email FROM users ORDER BY created_at',
  );
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) {
    throw new Error('No accounts yet. Make one first:\n\n  ./mainly.sh user you@example.com');
  }
  throw new Error(
    `This install has ${rows.length} accounts, so say which one:\n\n` +
      rows.map((r) => `  --as ${r.email}`).join('\n'),
  );
}

/** The domain to act on. Implied when only one is connected. */
async function resolveDomain(userId: string, given?: string): Promise<ManagedDomain> {
  const all = await listDomains(userId);
  if (!all.length) {
    throw new Error(
      'No mail server is connected.\n\n' +
        '  On the mail server:  sudo mainly-provision setup\n' +
        '  Then here:           ./mainly.sh domain connect <the string it printed>',
    );
  }
  if (!given) {
    if (all.length === 1) return all[0]!;
    throw new Error(`Which domain?\n\n${all.map((d) => `  ${d.domain}`).join('\n')}`);
  }
  const want = given.trim().toLowerCase();
  const hit = all.find((d) => d.domain === want);
  if (hit) return hit;
  if (want.includes('@')) {
    throw new Error(
      `'${given}' is an address, not a domain — and your login address is no longer an argument here.\n` +
        `Try the same command without it. Use \`--as ${given}\` if this install has several accounts.`,
    );
  }
  throw new Error(
    `${given} is not connected. Connected: ${all.map((d) => d.domain).join(', ')}`,
  );
}

function splitAddress(address: string): { localpart: string; domain: string } {
  const [localpart, domain] = address.trim().toLowerCase().split('@');
  if (!localpart || !domain) throw new Error(`'${address}' is not an address. Use user@domain.`);
  return { localpart, domain };
}

/* ── Reading from a person ───────────────────────────────────────────────── */

/** Prompt on stderr, read one line. Only ever called when stdin is a terminal;
 *  everything here also takes its answer as an argument, so a script never
 *  reaches a prompt. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${B}${question}${R} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Everything piped in, as text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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

/* ── The handover string ─────────────────────────────────────────────────── */

interface Handover {
  host: string;
  port: number;
  user: string;
  fingerprints: string[];
  domains: string[];
  grants: DomainGrant[];
  key: string;
}

/**
 * Decode what `mainly-provision setup` printed.
 *
 * Base64 of one JSON object, because it has to survive being pasted into a
 * terminal as a single line — a PEM key and a list of fingerprints do not.
 * Every field is checked here rather than trusted: this is operator input that
 * has been through a clipboard, and a truncated paste should say so plainly
 * instead of failing later as a connection error.
 */
function decodeHandover(raw: string): Handover {
  const cleaned = raw.trim().replace(/\s+/g, '');
  if (!cleaned) throw new Error('Nothing pasted.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cleaned, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      'That is not the string `mainly-provision setup` printed.\n' +
        'Copy the whole thing after `./mainly.sh domain connect` — it is one long line.',
    );
  }
  const o = parsed as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const host = typeof o.host === 'string' ? o.host.trim() : '';
  const key = typeof o.key === 'string' ? o.key : '';
  const domains = strings(o.domains).map((d) => d.toLowerCase());
  if (!host) throw new Error('That string names no mail server. Run setup on the server again.');
  if (!key.includes('PRIVATE KEY')) throw new Error('That string carries no usable key. Run setup on the server again.');
  if (!domains.length) throw new Error('That string names no domains. Run setup on the server again.');

  return {
    host,
    port: typeof o.port === 'number' && o.port > 0 ? o.port : 22,
    user: typeof o.user === 'string' && o.user ? o.user : 'mailprov',
    fingerprints: strings(o.fingerprints),
    domains,
    grants: strings(o.grants).filter(isDomainGrant),
    key,
  };
}

/** `purge` is only reachable through `delete`, and `updateDomain` refuses the
 *  pair without it. A hand-edited server config could name one and not the
 *  other; that is the server's business, not a reason to fail a connect. */
const coherent = (grants: DomainGrant[]): DomainGrant[] =>
  grants.includes('purge') && !grants.includes('delete')
    ? grants.filter((g) => g !== 'purge')
    : grants;

/* ── Rendering ───────────────────────────────────────────────────────────── */

function showDomain(d: ManagedDomain): void {
  const mark = d.status === 'ok' ? `${GR}●${R}` : d.status === 'pending' ? `${YL}○${R}` : `${RD}●${R}`;
  say(`  ${mark} ${B}${d.domain}${R}  ${D}${d.config.user}@${d.config.host}:${d.config.port}${R}`);
  if (d.error) {
    say(`      ${RD}${d.error}${R}`);
    return;
  }
  say(`      ${d.effective.length ? d.effective.join(', ') : 'nothing — this install can only read'}`);
  const blocked = d.grants.filter((g) => !d.effective.includes(g));
  if (blocked.length) {
    say(`      ${D}${blocked.join(', ')} — granted here, refused by the mail server${R}`);
  }
  if (d.status === 'pending') say(`      ${D}never checked — run \`domain doctor\`${R}`);
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/**
 * Connect a mail server from the string its own setup printed.
 *
 * The host key is not trusted on first use and not typed by hand: the server
 * listed its own public keys in the string, this reads the key the server
 * actually presents, and the two have to agree. Trust on first use is a
 * decision made once and visibly; this makes it once and automatically, against
 * an answer that came from the machine itself over a different path.
 */
async function connect(userId: string, arg: string | undefined, flags: Map<string, string>) {
  const raw =
    arg ??
    (process.stdin.isTTY
      ? await prompt('Paste the string from `mainly-provision setup`:')
      : (await readStdin()).trim());

  const h = decodeHandover(raw);

  hdr(`Connecting ${h.host}`);

  const presented = await readHostKey(h.host, h.port);
  if (h.fingerprints.length && !h.fingerprints.includes(presented)) {
    bad('the mail server presented a host key it did not list as its own');
    say('');
    note(`presented  ${presented}`);
    for (const f of h.fingerprints) note(`expected   ${f}`);
    say('');
    throw new Error(
      'Refusing to connect. Either something is between you and that machine, or its\n' +
        'host keys changed after setup ran. Run `mainly-provision setup` there again.',
    );
  }
  good(`host key checked against the ${h.fingerprints.length} that machine reported${h.fingerprints.length ? '' : ' — none, so unverified'}`);

  // What the server already agreed to, unless the operator asked for less. Not
  // more: `scope` cannot widen past what the mail server permits either, and
  // starting narrower than the machine's own answer only means a second step
  // nobody has a reason to take.
  const asked = flags.get('scope');
  const ceiling = asked ? SCOPES[asked] ?? parseScope(asked) : null;

  const connected: ManagedDomain[] = [];
  for (const domain of h.domains) {
    const existing = (await listDomains(userId)).find((d) => d.domain === domain);
    if (existing) {
      huh(`${domain} was already connected — left as it is`);
      continue;
    }
    const row = await connectDomain(userId, {
      domain,
      driver: 'ssh',
      host: h.host,
      port: h.port,
      user: h.user,
      hostKey: presented,
      privateKey: h.key,
    });
    const probe = await probeDomain(userId, row.id, { kind: 'session' });
    if (probe.status !== 'ok') {
      bad(`${domain}: ${probe.error ?? 'the mail server would not answer'}`);
      connected.push(await updateDomain(userId, row.id, { grants: [] }));
      continue;
    }
    const allowed = ceiling
      ? probe.serverGrants.filter((g) => ceiling.includes(g))
      : probe.serverGrants;
    connected.push(await updateDomain(userId, row.id, { grants: coherent(allowed) }));
    if (!probe.parity) {
      huh(`${domain}: that server's own maps disagree with each other`);
      note('No write can succeed until they are reconciled. On the mail server:');
      note('  sudo mainly-provision doctor');
    }
  }

  if (!connected.length) throw new Error('Nothing new to connect.');

  hdr('Connected');
  for (const d of connected) showDomain(d);
  say('');
  note('Also in the browser, under Settings → Mail server.');
  say('');
}

function parseScope(raw: string): DomainGrant[] {
  const wanted = raw.split(',').map((g) => g.trim()).filter(Boolean);
  const unknown = wanted.filter((g) => !isDomainGrant(g));
  if (unknown.length) {
    throw new Error(
      `Unknown scope '${raw}'.\n\n` +
        `  full   ${SCOPES.full!.join(', ')}\n` +
        `  keep   ${SCOPES.keep!.join(', ')}\n` +
        `  read   ${SCOPES.read!.join(', ')}\n` +
        `  none   nothing — connected, but this install can only read mail\n\n` +
        `Or a comma-separated list of: ${DOMAIN_GRANTS.join(', ')}`,
    );
  }
  return wanted as DomainGrant[];
}

async function status(userId: string, email: string) {
  const domains = await listDomains(userId);
  hdr(`Mail servers  ${D}${email}${R}`);
  if (!domains.length) {
    say('');
    say('  Nothing connected. This install holds one credential per mailbox and');
    say('  never writes to a mail server, which is the default and is fine.');
    say('');
    note('To change that:');
    note('  On the mail server   sudo mainly-provision setup');
    note('  Here                 ./mainly.sh domain connect <the string it printed>');
    say('');
    return;
  }
  say('');
  for (const d of domains) showDomain(d);
  say('');
  note('domain doctor    check it end to end');
  note('domain scope     change what it may do');
  say('');
}

/**
 * Every layer, in order, with the fix for the first one that fails.
 *
 * The point is to answer "which half is broken" without the operator having to
 * know there are halves. A refusal from the mail server, a key that reaches a
 * shell instead of the script, and a domain the server does not host all look
 * the same from a failed create.
 */
async function doctor(userId: string) {
  const domains = await listDomains(userId);
  if (!domains.length) {
    hdr('Nothing connected');
    note('On the mail server:  sudo mainly-provision setup');
    say('');
    return;
  }

  let failed = false;
  let warned = false;
  for (const d of domains) {
    hdr(`${d.domain}  ${D}${d.config.user}@${d.config.host}:${d.config.port}${R}`);

    if (!d.config.hostKey) {
      bad('no host key is pinned, so that machine cannot be identified');
      note(`Fix: ./mainly.sh domain forget ${d.domain}, then connect it again.`);
      failed = true;
      continue;
    }

    const probe = await probeDomain(userId, d.id, { kind: 'session' });
    if (probe.status !== 'ok') {
      bad(probe.error ?? 'unreachable');
      failed = true;
      const message = probe.error ?? '';
      if (/did not answer with a provisioning reply/i.test(message)) {
        note("The key reached a shell rather than the script. On the mail server:");
        note('  sudo mainly-provision doctor');
      } else if (/host key/i.test(message)) {
        note("That machine's host key changed. Confirm it really is your server, then");
        note(`  ./mainly.sh domain forget ${d.domain}  and connect it again.`);
      } else if (/private or reserved address/i.test(message)) {
        note('The mail server is on a private network. Add to .env and restart:');
        note('  ALLOW_PRIVATE_IMAP_HOSTS=true');
      } else {
        note(`Is ${d.config.host}:${d.config.port} reachable from this machine, and is sshd up?`);
        note('On the mail server:  sudo mainly-provision doctor');
      }
      continue;
    }

    good(`reachable — postfix ${probe.postfix ?? '?'} · dovecot ${probe.dovecot ?? '?'}`);

    if (!probe.parity) {
      bad("that server's maps disagree with each other; no write can succeed");
      note('On the mail server:  sudo mainly-provision doctor');
      failed = true;
    }

    if (!probe.serverGrants.length) {
      bad('the mail server permits nothing for this domain');
      failed = true;
      if (probe.serves.length && !probe.serves.includes(d.domain)) {
        note(`That machine serves ${probe.serves.join(', ')} — not ${d.domain}.`);
        note('Either the wrong domain is connected here, or the wrong server.');
      } else {
        note(`Add it to /etc/mainly-provision.conf there, or re-run setup:`);
        note(`  domain ${d.domain} list,create,delete,password,alias,purge`);
      }
      continue;
    }
    good(`the mail server permits ${probe.serverGrants.join(', ')}`);

    const dead = d.grants.filter((g) => !probe.serverGrants.includes(g));
    if (dead.length) {
      warned = true;
      huh(`${dead.join(', ')} — granted here, refused there, so it does nothing`);
    }

    const unused = probe.serverGrants.filter((g) => !d.grants.includes(g));
    if (unused.length) {
      warned = true;
      huh(`${unused.join(', ')} — the server would allow it, but it is off here`);
      note(`Turn it on:  ./mainly.sh domain scope ${d.domain} full`);
    }

    if (d.grants.includes('list')) {
      const boxes = await listMailboxes(userId, d.id);
      good(`${boxes.length} address${boxes.length === 1 ? '' : 'es'} on that server`);
    }
  }

  say('');
  if (failed) say(`  ${RD}Fix the ✗ lines above.${R}`);
  else if (warned) say(`  ${GR}Working.${R} ${D}The ! lines are switches that are on here and off there.${R}`);
  else say(`  ${GR}Everything checks out.${R}`);
  say('');
}

/* ── Entry ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, second, third] = positional;

  if (!command || command === 'help') throw new Error(USAGE);

  // The one command that needs no account: it reads a public key off a host.
  if (command === 'hostkey') {
    const host = flags.get('host') ?? second;
    if (!host) throw new Error('usage: domain hostkey <host> [--port 22]');
    const key = await readHostKey(host, Number(flags.get('port') ?? 22));
    console.error(`host key for ${host}:`);
    console.log(key);
    return;
  }

  const user = await resolveUser(flags);
  const userId = user.id;

  switch (command) {
    case 'connect':
      await connect(userId, second, flags);
      break;

    case 'status':
    case 'list':
      await status(userId, user.email);
      break;

    case 'doctor':
    case 'probe':
      await doctor(userId);
      break;

    /* Another domain on a mail server already connected. The credential is
     * reused rather than re-pasted; the server is asked whether it actually
     * hosts the domain before anything is written. */
    case 'add': {
      if (!second) throw new Error('usage: domain add <domain>');
      const wanted = second.trim().toLowerCase();
      const from = await resolveDomain(userId, flags.get('server'));
      const probe = await probeDomain(userId, from.id, { kind: 'session' });
      if (probe.status !== 'ok') {
        throw new Error(
          `${from.config.host} is not answering, so it cannot be asked about ${wanted}.\n` +
            'Run `./mainly.sh domain doctor`.',
        );
      }
      if (probe.serves.length && !probe.serves.includes(wanted)) {
        throw new Error(
          `${from.config.host} has no addresses for ${wanted}.\n` +
            `It serves: ${probe.serves.join(', ')}`,
        );
      }
      const row = await attachDomain(userId, from.id, wanted);
      const check = await probeDomain(userId, row.id, { kind: 'session' });
      const scope = flags.get('scope');
      const ceiling = scope ? SCOPES[scope] ?? parseScope(scope) : null;
      const allowed = ceiling
        ? check.serverGrants.filter((g) => ceiling.includes(g))
        : check.serverGrants;
      const saved = await updateDomain(userId, row.id, { grants: coherent(allowed) });
      hdr('Connected');
      showDomain(saved);
      if (!saved.effective.length) {
        say('');
        note(`${from.config.host} permits nothing for ${wanted} yet. There:`);
        note(`  sudo mainly-provision setup    (or add a \`domain ${wanted} …\` line by hand)`);
      }
      say('');
      break;
    }

    case 'scope':
    case 'grant': {
      // `scope <what>` when only one domain is connected; `scope <domain>
      // <what>` otherwise. Which is which is decided by whether the first
      // argument is a scope name, because a domain never is.
      const looksLikeScope = second !== undefined && (second in SCOPES || !second.includes('.'));
      const domainArg = looksLikeScope ? undefined : second;
      const scopeArg = looksLikeScope ? second : third;
      if (!scopeArg) {
        throw new Error(
          'usage: domain scope [domain] <full | keep | read | list,create,…>\n\n' +
            DOMAIN_GRANTS.map((g) => `  ${g.padEnd(10)} ${DOMAIN_GRANT_LABELS[g]}`).join('\n'),
        );
      }
      const target = await resolveDomain(userId, domainArg);
      const wanted = SCOPES[scopeArg] ?? parseScope(scopeArg);
      const saved = await updateDomain(userId, target.id, { grants: coherent(wanted) });
      hdr(saved.domain);
      showDomain(saved);
      const dead = saved.grants.filter((g) => !saved.effective.includes(g));
      if (dead.length) {
        say('');
        note(`The mail server refuses ${dead.join(', ')}, so granting it here does nothing.`);
        note('Widen it there and it takes effect at the next check:');
        note(`  sudo mainly-provision setup`);
      }
      say('');
      break;
    }

    case 'addresses':
    case 'mailboxes': {
      const target = await resolveDomain(userId, second);
      const boxes = await listMailboxes(userId, target.id);
      hdr(`${target.domain}  ${D}${boxes.length} address${boxes.length === 1 ? '' : 'es'}${R}`);
      for (const b of boxes) {
        say(`  ${b.linked ? `${GR}●${R}` : ' '} ${b.address}`);
      }
      if (boxes.some((b) => b.linked)) {
        say('');
        note('● already synced by this install');
      }
      say('');
      break;
    }

    case 'new':
    case 'create': {
      if (!second) throw new Error('usage: domain new <address>   (password on stdin, or generated)');
      const { localpart, domain } = splitAddress(second);
      const target = await resolveDomain(userId, domain);
      const supplied = await passwordFromStdin();
      const password = supplied ?? generatePassword();
      await createMailbox(userId, target.id, { localpart, password }, { kind: 'session' });
      console.error(`\n  ${GR}✓${R} created ${B}${localpart}@${domain}${R}`);
      if (!supplied) {
        console.error(`     ${D}password, shown once:${R}`);
        console.log(password);
      }
      console.error('');
      break;
    }

    case 'rm':
    case 'delete': {
      if (!second) throw new Error('usage: domain rm <address> [--purge]');
      const { localpart, domain } = splitAddress(second);
      const target = await resolveDomain(userId, domain);
      const purge = flags.get('purge') === 'true';
      await removeMailbox(userId, target.id, { localpart, purge }, { kind: 'session' });
      console.error(
        purge
          ? `\n  ${GR}✓${R} deleted ${localpart}@${domain} ${RD}and destroyed its stored mail${R}\n`
          : `\n  ${GR}✓${R} deleted ${localpart}@${domain}\n     ${D}its mail is still on the server; recreating the address brings it back${R}\n`,
      );
      break;
    }

    case 'forget': {
      const target = await resolveDomain(userId, second);
      await disconnectDomain(userId, target.id);
      console.error(
        `\n  ${GR}✓${R} forgot ${target.domain}\n` +
          `     ${D}the key and the permissions are gone from this install.${R}\n` +
          `     ${D}no address and no mail was touched.${R}\n\n` +
          `     ${D}To revoke it on the mail server too:  sudo mainly-provision uninstall${R}\n`,
      );
      break;
    }

    case 'history':
    case 'ops': {
      const ops = await listOps(userId, Number(flags.get('limit') ?? 50));
      if (!ops.length) {
        hdr('Nothing recorded yet');
        note('Every attempt to change a mail server is written here, successful or not.');
        say('');
        break;
      }
      hdr('History');
      for (const o of ops) {
        const mark = o.status === 'ok' ? `${GR}ok    ${R}` : `${RD}FAILED${R}`;
        say(
          `  ${D}${o.createdAt}${R}  ${mark}  ${o.action.padEnd(10)} ${o.target}  ${D}(${o.actor})${R}` +
            (o.detail ? `\n      ${D}${o.detail}${R}` : ''),
        );
      }
      say('');
      break;
    }

    default:
      throw new Error(`Unknown command '${command}'.\n\n${USAGE}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err: Error) => {
    console.error(`\n${err.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
