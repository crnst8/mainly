/**
 * What a provisioning driver has to be able to do.
 *
 * One driver exists today — `ssh`, which talks to a flat-file Postfix and
 * Dovecot host through a forced command. The interface is here rather than
 * inlined into it because the second driver is the one that decides whether
 * this design was right, and mailcow, Mailu and Migadu all expose the same
 * five verbs behind very different transports.
 *
 * Every mutating method is optional. A driver that cannot delete omits
 * `remove` and leaves `'delete'` out of `capabilities()`; nothing above has to
 * special-case it, because the service checks capability before it dispatches.
 */

import type { DomainGrant, ManagedAlias, ManagedMailbox } from '../../../contract/types.ts';

/** Everything a driver needs for one call. Assembled by the service, which is
 *  the only place the sealed credential is opened. */
export interface DriverContext {
  domain: string;
  /** Non-secret connection detail, as stored in `mail_domains.config`. */
  config: Record<string, unknown>;
  /** The decrypted credential. Lives for the duration of one call. */
  secret: string;
}

export interface ProbeResult {
  postfix: string | null;
  dovecot: string | null;
  parity: boolean;
  /** What the server says it will allow for this domain. */
  serverGrants: DomainGrant[];
  /** Every domain that machine serves, whether or not it is on its allowlist.
   *  Empty from a helper too old to report it. */
  serves: string[];
}

export interface DomainDriver {
  readonly kind: string;

  /** What this driver can do at all, before either grant set narrows it. */
  capabilities(): DomainGrant[];

  /** Reachability, versions, and the server's own allowlist. Never mutates. */
  probe(ctx: DriverContext): Promise<ProbeResult>;

  list(ctx: DriverContext): Promise<ManagedMailbox[]>;

  create?(ctx: DriverContext, input: { localpart: string; password: string }): Promise<void>;
  remove?(ctx: DriverContext, input: { localpart: string; purge: boolean }): Promise<void>;
  setPassword?(ctx: DriverContext, input: { localpart: string; password: string }): Promise<void>;

  listAliases?(ctx: DriverContext): Promise<ManagedAlias[]>;
  addAlias?(ctx: DriverContext, input: { localpart: string; target: string }): Promise<void>;
  removeAlias?(ctx: DriverContext, input: { localpart: string }): Promise<void>;
}
