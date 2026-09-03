/**
 * The driver registry.
 *
 * One entry today. It is a lookup rather than an import because the driver name
 * is a text column: a row written by a newer version of this application, or by
 * hand, can name something this build does not have, and the honest answer to
 * that is a clear error rather than a crash on an undefined method.
 */

import type { DomainDriver } from './types.ts';
import { sshDriver } from './ssh.ts';

const DRIVERS: Record<string, DomainDriver> = {
  [sshDriver.kind]: sshDriver,
};

export const DRIVER_KINDS = Object.keys(DRIVERS);

export const driverFor = (kind: string): DomainDriver | null => DRIVERS[kind] ?? null;

export type { DomainDriver, DriverContext, ProbeResult } from './types.ts';

/* `scanHostKey` is deliberately *not* re-exported here.
 *
 * It opens an unauthenticated connection to a host the caller names, which
 * makes it the one request-forgery surface in this module. Anything reaching
 * for it should go through `service.readHostKey`, which applies net-guard
 * first. Leaving it off the module's public face means that is the easy path
 * rather than the remembered one. */
