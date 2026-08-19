/**
 * Connection verification.
 *
 * Runs before an account is stored, so the user finds out about a wrong
 * password in the wizard rather than from an empty inbox ten minutes later.
 *
 * This endpoint takes user-supplied hostnames and opens outbound connections
 * to them, which makes it the SSRF surface of the application. Hosts are
 * checked against private ranges unless the operator has explicitly opted in
 * — which self-hosted deployments must, and which is exactly why it is a
 * conscious switch rather than a default.
 */

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { config } from '../../config.ts';
import type { ServerConfig, VerifyResult } from '../../contract/types.ts';
import { assertHostAllowed } from '../../sync/pool.ts';

export interface VerifyInput {
  address: string;
  password: string;
  imap: ServerConfig;
  smtp: ServerConfig;
}

export async function verify(input: VerifyInput): Promise<VerifyResult> {
  assertHostAllowed(input.imap.host);
  assertHostAllowed(input.smtp.host);

  // Run both in parallel — they are independent, and the wizard waits on the
  // slower of the two rather than their sum.
  const [imap, smtp] = await Promise.all([
    verifyImap(input).catch((err: Error) => ({
      ok: false,
      error: explain(err),
      latencyMs: null,
      capabilities: [] as string[],
    })),
    verifySmtp(input).catch((err: Error) => ({ ok: false, error: explain(err), latencyMs: null })),
  ]);

  return { imap, smtp };
}

/**
 * The most useful sentence available about why a connection failed.
 *
 * imapflow reports a rejected LOGIN as "Command failed", which tells the person
 * typing a password precisely nothing. The server's own response text is on the
 * error object and is much better — Dovecot says "Authentication failed." — so
 * that is preferred, and the common transport failures get named outright
 * because "ECONNREFUSED" is not a sentence either.
 */
function explain(err: Error): string {
  const e = err as Error & {
    responseText?: string;
    authenticationFailed?: boolean;
    code?: string;
    serverResponseCode?: string;
  };

  if (e.authenticationFailed || /AUTHENTICATIONFAILED/i.test(e.serverResponseCode ?? '')) {
    return e.responseText?.trim() || 'The server rejected this username and password.';
  }

  switch (e.code) {
    case 'ECONNREFUSED':
      return 'Nothing is listening on that host and port.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'That hostname does not resolve.';
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return 'The connection timed out. Check the port, and whether TLS is right for it.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "The server's certificate is for a different hostname.";
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'The server uses a self-signed certificate.';
    default:
      return e.responseText?.trim() || err.message;
  }
}

async function verifyImap(input: VerifyInput): Promise<VerifyResult['imap']> {
  const started = performance.now();
  const servername = input.imap.host;
  const host = config.imap.hostOverrides.get(servername) ?? servername;

  const client = new ImapFlow({
    host,
    port: input.imap.port,
    secure: input.imap.security === 'tls',
    servername,
    auth: { user: input.imap.username || input.address, pass: input.password },
    logger: false,
    emitLogs: false,
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
    greetingTimeout: config.imap.connectTimeoutMs,
  });

  try {
    await client.connect();
    // Reported back to the UI so capability-dependent behaviour (CONDSTORE,
    // QRESYNC, MOVE) is visible rather than inferred.
    const capabilities = [...(client.capabilities?.keys() ?? [])];
    return {
      ok: true,
      error: null,
      latencyMs: Math.round(performance.now() - started),
      capabilities,
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function verifySmtp(input: VerifyInput): Promise<VerifyResult['smtp']> {
  const started = performance.now();
  const servername = input.smtp.host;
  const host = config.imap.hostOverrides.get(servername) ?? servername;

  const transport = nodemailer.createTransport({
    host,
    port: input.smtp.port,
    secure: input.smtp.security === 'tls',
    requireTLS: input.smtp.security === 'starttls',
    auth: { user: input.smtp.username || input.address, pass: input.password },
    tls: { servername, minVersion: 'TLSv1.2' },
    connectionTimeout: config.imap.connectTimeoutMs,
  });

  try {
    await transport.verify();
    return { ok: true, error: null, latencyMs: Math.round(performance.now() - started) };
  } finally {
    transport.close();
  }
}
