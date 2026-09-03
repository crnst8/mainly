/**
 * The permission rules, with no dependencies.
 *
 * Separate from `service.ts` because these are decisions, not plumbing: they
 * are the whole of what domain control will and will not do, they are the part
 * worth reading on its own, and keeping them clear of the database means they
 * can be tested as what they are — a table of answers — rather than through a
 * connection.
 */

import type { DomainGrant } from '../../contract/types.ts';

/**
 * What will actually work: the intersection of all three gates.
 *
 * A grant has to survive what the driver can do at all, what this install was
 * told it may do, and what the mail server itself permits. The third is the one
 * that matters and the one this application cannot write; the first two exist
 * so a mistake is caught before it becomes a request, and so the UI can be
 * honest about which switches will do something.
 *
 * Order follows `grants`, because this is rendered as a list and a set that
 * reorders itself between reads reads as a bug.
 */
export const effectiveGrants = (
  grants: DomainGrant[],
  serverGrants: DomainGrant[],
  capabilities: DomainGrant[],
): DomainGrant[] => grants.filter((g) => serverGrants.includes(g) && capabilities.includes(g));

/**
 * The shapes a mail server will accept, mirrored from `scripts/mainly-provision`.
 *
 * Deliberately narrower than RFC 5321, and identical to the helper's own
 * character classes. The two have to stay in step: a localpart accepted here
 * and refused there is a create that fails after someone has typed a password.
 *
 * Everything outside these classes is refused rather than escaped. An address
 * this rejects can still be made by hand on the server; an address it accepts
 * cannot surprise a shell, a Postfix map, or a passwd-file's colon-separated
 * fields.
 */
export const LOCALPART_RE = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/;

export const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
