/**
 * One answer to "is this host allowed to be contacted".
 *
 * Three call sites take a host from outside this process — the account wizard
 * (`assertHostAllowed`), autoconfig discovery, and an unsubscribe link out of a
 * stranger's mail — and every one is an SSRF surface. They used to disagree: the
 * unsubscribe path resolved the name and checked every answer, while the
 * mail-server path pattern-matched the string it was handed, so `2130706433` and
 * the public DNS record `localtest.me` both reached loopback through it. A guard
 * that can be spelled around is not a guard, so all three come through here.
 *
 * The rule this adds on top of ip.ts: a **name is resolved before it is judged**,
 * and *every* answer is checked. Nothing about `localtest.me` looks like
 * 127.0.0.1 until you ask a resolver.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { config } from '../config.ts';
import { badRequest, upstream } from './errors.ts';
import { bareHost, isPrivateAddress } from './ip.ts';

export { bareHost, isPrivateAddress };

/**
 * Refuse a host that is, or resolves to, an address we will not contact.
 *
 * `ALLOW_PRIVATE_IMAP_HOSTS` turns this off wholesale, which self-hosted setups
 * reaching a mail server over a LAN or a VPN legitimately need.
 *
 * `label` names the surface in the error, because "refusing to connect" without
 * saying to what is the kind of message that gets a bug report instead of a fix.
 */
export async function assertPublicHost(host: string, label = 'that address'): Promise<void> {
  if (config.imap.allowPrivateHosts) return;

  const bare = bareHost(host.trim());
  if (!bare) throw badRequest(`No host given for ${label}.`);

  // A name with a port glued on is not a host, and must never reach a resolver.
  if (!isIP(bare) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i.test(bare)) {
    throw badRequest(`${host} is not a valid hostname.`);
  }

  const addresses = isIP(bare)
    ? [bare]
    : await lookup(bare, { all: true })
        .then((rows) => rows.map((r) => r.address))
        .catch(() => {
          throw upstream(`Could not resolve ${bare}.`);
        });

  // Every answer, not the first: a name with one public and one loopback record
  // must not pass on a coin flip.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw badRequest(
        `${label} points at a private or reserved address (${address}). Refusing to connect. ` +
          'Set ALLOW_PRIVATE_IMAP_HOSTS=true if this is a server on your own network.',
      );
    }
  }
}
