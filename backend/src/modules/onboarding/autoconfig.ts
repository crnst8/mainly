/**
 * Server discovery.
 *
 * The user types an address; we work out the rest. Sources are tried in
 * descending order of authority, and the source is reported back so the UI can
 * say *how* it knows rather than presenting hosts as magic.
 *
 *   1. Accounts we already have on this domain — by definition correct.
 *   2. DNS SRV (RFC 6186) — the standard, and what a well-run mail domain has.
 *   3. Mozilla autoconfig at autoconfig.<domain>/mail/config-v1.1.xml
 *   4. The ISPDB, for the big providers.
 *   5. Convention: mail.<domain> on 993/587. Right far more often than not,
 *      and cheap to verify, which is the next step anyway.
 */

import { Resolver } from 'node:dns/promises';
import { one } from '../../db/index.ts';
import type { Autoconfig } from '../../contract/types.ts';

const resolver = new Resolver({ timeout: 3000, tries: 2 });

export async function discover(address: string, userId: string): Promise<Autoconfig> {
  const domain = address.split('@')[1]?.toLowerCase();
  if (!domain) {
    throw new Error('Address has no domain part');
  }

  const known = await fromExistingAccount(domain, address, userId);
  if (known) return known;

  const srv = await fromSrv(domain, address);
  if (srv) return srv;

  const mozilla = await fromMozillaAutoconfig(domain, address);
  if (mozilla) return mozilla;

  return guess(domain, address);
}

/** The strongest signal available: another mailbox on the same domain that is
 *  already syncing. Nothing beats a configuration known to work. */
async function fromExistingAccount(
  domain: string,
  address: string,
  userId: string,
): Promise<Autoconfig | null> {
  const row = await one<{
    imap_host: string;
    imap_port: number;
    imap_security: 'tls' | 'starttls' | 'none';
    smtp_host: string;
    smtp_port: number;
    smtp_security: 'tls' | 'starttls' | 'none';
  }>(
    `SELECT imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security
       FROM accounts
      WHERE user_id = $1 AND domain = $2 AND status IN ('ok', 'syncing')
      LIMIT 1`,
    [userId, domain],
  );
  if (!row) return null;

  return {
    source: 'known',
    confidence: 1,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      security: row.imap_security,
      username: address,
    },
    smtp: {
      host: row.smtp_host,
      port: row.smtp_port,
      security: row.smtp_security,
      username: address,
    },
  };
}

async function fromSrv(domain: string, address: string): Promise<Autoconfig | null> {
  const [imaps, submission] = await Promise.all([
    resolver.resolveSrv(`_imaps._tcp.${domain}`).catch(() => []),
    resolver.resolveSrv(`_submission._tcp.${domain}`).catch(() => []),
  ]);

  const imap = imaps.sort((a, b) => a.priority - b.priority)[0];
  const smtp = submission.sort((a, b) => a.priority - b.priority)[0];
  if (!imap) return null;

  return {
    source: 'srv',
    confidence: 0.95,
    imap: { host: imap.name, port: imap.port, security: 'tls', username: address },
    smtp: smtp
      ? { host: smtp.name, port: smtp.port, security: 'starttls', username: address }
      : { host: `mail.${domain}`, port: 587, security: 'starttls', username: address },
  };
}

async function fromMozillaAutoconfig(domain: string, address: string): Promise<Autoconfig | null> {
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'follow' });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseAutoconfigXml(xml, address);
      if (parsed) return parsed;
    } catch {
      // Every one of these is expected to fail for most domains.
    }
  }
  return null;
}

/** Deliberately a regex reader, not an XML parser: we need four values from a
 *  document we do not control, and adding a parser dependency for that is not
 *  a trade worth making. */
function parseAutoconfigXml(xml: string, address: string): Autoconfig | null {
  const block = (type: 'imap' | 'smtp') => {
    const re = new RegExp(
      `<incomingServer type="${type}"[^>]*>([\\s\\S]*?)</incomingServer>|` +
        `<outgoingServer type="${type}"[^>]*>([\\s\\S]*?)</outgoingServer>`,
      'i',
    );
    const m = re.exec(xml);
    const body = m?.[1] ?? m?.[2];
    if (!body) return null;
    const host = /<hostname>(.*?)<\/hostname>/i.exec(body)?.[1];
    const port = Number(/<port>(.*?)<\/port>/i.exec(body)?.[1]);
    const socket = /<socketType>(.*?)<\/socketType>/i.exec(body)?.[1]?.toUpperCase();
    if (!host || !Number.isFinite(port)) return null;
    return {
      host,
      port,
      security: (socket === 'SSL' ? 'tls' : socket === 'STARTTLS' ? 'starttls' : 'none') as
        | 'tls'
        | 'starttls'
        | 'none',
      username: address,
    };
  };

  const imap = block('imap');
  const smtp = block('smtp');
  if (!imap) return null;

  return {
    source: 'autoconfig',
    confidence: 0.9,
    imap,
    smtp: smtp ?? { host: imap.host, port: 587, security: 'starttls', username: address },
  };
}

/** Convention. Correct for most self-hosted Postfix/Dovecot setups, including
 *  the one this app was built against. Confidence is set below the threshold
 *  that auto-collapses the manual fields, so the user sees it is a guess. */
function guess(domain: string, address: string): Autoconfig {
  return {
    source: 'guess',
    confidence: 0.45,
    imap: { host: `mail.${domain}`, port: 993, security: 'tls', username: address },
    smtp: { host: `mail.${domain}`, port: 587, security: 'starttls', username: address },
  };
}
