/**
 * Bulk mailbox import.
 *
 * Running a three-step wizard forty-five times is not onboarding, it is data
 * entry with ceremony. The insight this screen is built on is that everything
 * hard about adding a mailbox is *identical* across all of them — same server,
 * same ports, same security, same auth — and everything that differs is two
 * short strings. So the shared part is stated once, at the top, and the
 * repeated part is a grid you can paste into.
 *
 * Four steps, in the order the information becomes available:
 *
 *   1. Server   — one host (with `{domain}` if the certs are per-domain), ports.
 *   2. Mailboxes — the grid. Paste from anywhere; the parser is forgiving.
 *   3. Domains  — priority and colour per domain, derived from what you typed,
 *                 so eight domains get tiered and coloured in one pass rather
 *                 than forty-five times in settings afterwards.
 *   4. Import   — rows resolve live, in chunks, and failures stay on screen
 *                 next to a retry rather than replacing the whole result with
 *                 an error.
 */

import { useMemo, useState } from 'react';
import { Check, Close, Plus, Trash, Warning } from '@/components/icons';
import { Button, Field, Segmented, Spinner, Toggle } from '@/components/ui';
import { getApi } from '@/lib/api';
import { useStore } from '@/lib/store';
import {
  BULK_CHUNK,
  PRIORITIES,
  type BulkOnboardRow,
  type DomainPreset,
  type Priority,
  type Security,
} from '@/lib/types';
import './bulk.css';

type Step = 'server' | 'mailboxes' | 'domains' | 'import';

/** A row being edited. `status` is local UI state, not part of the contract. */
interface Row {
  key: number;
  address: string;
  password: string;
  /** Null means "inherit this domain's preset". */
  priority: Priority | null;
  status: 'idle' | 'working' | 'ok' | 'warn' | 'error';
  message: string | null;
}

const PALETTE = [
  'oklch(64% 0.16 258)',
  'oklch(64% 0.16 292)',
  'oklch(66% 0.16 28)',
  'oklch(64% 0.14 168)',
  'oklch(68% 0.16 88)',
  'oklch(64% 0.17 338)',
  'oklch(64% 0.16 218)',
  'oklch(62% 0.14 128)',
  'oklch(50% 0 0)',
];

let nextKey = 1;
const blank = (): Row => ({
  key: nextKey++,
  address: '',
  password: '',
  priority: null,
  status: 'idle',
  message: null,
});

const domainOf = (address: string): string => address.split('@')[1]?.trim().toLowerCase() ?? '';
const looksValid = (address: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());

/**
 * Parse whatever was pasted.
 *
 * Accepts `address:password`, `address,password`, `address<tab>password`, and a
 * bare address on its own. Deliberately forgiving: the text is coming out of a
 * password manager export, a spreadsheet, or a provisioning script, and none of
 * them agree on a separator. A password containing a colon still works, because
 * only the *first* separator splits.
 */
export function parsePasted(text: string): { address: string; password: string }[] {
  const out: { address: string; password: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('@');
    if (at < 0) continue;
    // Search for the separator *after* the address, so an address is never split
    // on a colon that belongs to a scheme or a port.
    const sep = trimmed.slice(at).search(/[:,\t;|]|\s{2,}/);
    if (sep < 0) {
      out.push({ address: trimmed, password: '' });
      continue;
    }
    const cut = at + sep;
    out.push({
      address: trimmed.slice(0, cut).trim(),
      password: trimmed.slice(cut + 1).trim(),
    });
  }
  return out;
}

export function BulkOnboarding({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);

  const [step, setStep] = useState<Step>('server');

  /* Shared server settings — the whole reason this screen exists. */
  const [host, setHost] = useState('mail.{domain}');
  const [imapPort, setImapPort] = useState(993);
  const [imapSecurity, setImapSecurity] = useState<Security>('tls');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecurity, setSmtpSecurity] = useState<Security>('starttls');

  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [sharedPassword, setSharedPassword] = useState('');
  const [useShared, setUseShared] = useState(false);
  const [presets, setPresets] = useState<Record<string, DomainPreset>>({});
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);

  const filled = rows.filter((r) => r.address.trim().length > 0);
  const domains = useMemo(
    () => [...new Set(filled.map((r) => domainOf(r.address)).filter(Boolean))].sort(),
    [filled],
  );

  const invalid = filled.filter((r) => !looksValid(r.address));

  /* Duplicates inside one paste. The backend catches these too — the second
     INSERT hits the unique constraint — but only after spending an IMAP and an
     SMTP handshake on a row that could never succeed. Catching them here is
     free, and it names the problem rather than reporting it as a failure. */
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of filled) {
      const key = r.address.trim().toLowerCase();
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [filled]);
  const missingPassword = useShared
    ? sharedPassword.length === 0
    : filled.some((r) => !r.password);

  /* ── Row editing ────────────────────────────────────────────────────────── */

  const patch = (key: number, next: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const addRow = () => setRows((prev) => [...prev, blank()]);

  const removeRow = (key: number) =>
    setRows((prev) => {
      const kept = prev.filter((r) => r.key !== key);
      // Never leave the grid with nothing in it — an empty table has no affordance
      // to type into and reads as broken.
      return kept.length ? kept : [blank()];
    });

  /**
   * Paste into the grid.
   *
   * Multi-line paste fills from the row you pasted into and grows the grid to
   * fit, which is what makes bringing in forty-five mailboxes one keystroke. A
   * single-line paste is left to the browser so ordinary editing still works.
   */
  const onPaste = (key: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n') && !/[:,\t;|]/.test(text.slice(text.indexOf('@'))) ) return;
    const parsed = parsePasted(text);
    if (!parsed.length) return;
    e.preventDefault();

    setRows((prev) => {
      const at = prev.findIndex((r) => r.key === key);
      const before = prev.slice(0, Math.max(0, at));
      const after = prev.slice(Math.max(0, at) + 1).filter((r) => r.address.trim());
      const inserted = parsed.map((p) => ({ ...blank(), address: p.address, password: p.password }));
      return [...before, ...inserted, ...after];
    });
  };

  /* ── Import ─────────────────────────────────────────────────────────────── */

  async function run() {
    setStep('import');
    setImporting(true);

    const queue = filled.filter((r) => looksValid(r.address) && r.status !== 'ok');
    setRows((prev) =>
      prev.map((r) =>
        queue.some((q) => q.key === r.key) ? { ...r, status: 'working', message: null } : r,
      ),
    );

    const api = await getApi();
    const template = {
      imap: { hostTemplate: host, port: imapPort, security: imapSecurity },
      smtp: { hostTemplate: host, port: smtpPort, security: smtpSecurity },
    };

    // Chunked rather than one request. Forty-five mailboxes is forty-five IMAP
    // and SMTP handshakes; sending them as one request means a minute of
    // nothing, and a progress bar that is a lie. A chunk lands every few
    // seconds and the grid fills in as it goes.
    for (let i = 0; i < queue.length; i += BULK_CHUNK) {
      const slice = queue.slice(i, i + BULK_CHUNK);
      let result: { rows: BulkOnboardRow[] };
      try {
        result = await api.bulkCreateAccounts({
          ...template,
          accounts: slice.map((r) => ({
            address: r.address.trim(),
            password: useShared ? sharedPassword : r.password,
            priority: r.priority ?? presets[domainOf(r.address)]?.priority ?? 'normal',
            label: null,
            displayName: null,
          })),
        });
      } catch (err) {
        // The request itself failed — rate limit, signed out, server down. Mark
        // this chunk and keep going; the rest may well succeed.
        const message = err instanceof Error ? err.message : String(err);
        setRows((prev) =>
          prev.map((r) =>
            slice.some((s) => s.key === r.key) ? { ...r, status: 'error', message } : r,
          ),
        );
        continue;
      }

      setRows((prev) =>
        prev.map((r) => {
          const outcome = result.rows.find(
            (o) => o.address === r.address.trim().toLowerCase() && slice.some((s) => s.key === r.key),
          );
          if (!outcome) return r;
          return {
            ...r,
            status: outcome.ok ? (outcome.smtpWarning ? 'warn' : 'ok') : 'error',
            message: outcome.error ?? outcome.smtpWarning,
          };
        }),
      );
    }

    /* Colours are a preference, not an account column, so they are written once
       here rather than per row. */
    const colors = Object.entries(presets).reduce<Record<string, string>>((acc, [domain, p]) => {
      if (p.color) acc[domain] = p.color;
      return acc;
    }, {});
    if (prefs && Object.keys(colors).length) {
      await savePrefs({
        theme: { ...prefs.theme, domainColors: { ...prefs.theme.domainColors, ...colors } },
      });
    }

    // Re-read rather than pushing the created rows in: the accounts now carry
    // server-assigned sidebar positions and sync status, and the folder tree only
    // exists after the first pass has listed it.
    const [accounts, folders] = await Promise.all([api.listAccounts(), api.listFolders()]);
    useStore.setState({ accounts, folders });

    setImporting(false);
    setDone(true);
  }

  const counts = {
    ok: rows.filter((r) => r.status === 'ok').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    error: rows.filter((r) => r.status === 'error').length,
  };

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="bulk">
      <Steps step={step} />

      {step === 'server' && (
        <section className="bulk__step" aria-label="Server settings">
          <p className="bulk__lede">
            Every mailbox on one server shares these. State them once here and the rest of the
            import is an address and a password per mailbox.
          </p>

          <Field
            label="Mail server"
            hint={
              host.includes('{domain}')
                ? 'One host per domain. {domain} becomes each address’s own domain.'
                : 'One host for every mailbox, whatever their domains.'
            }
          >
            <input
              className="input input--mono"
              autoFocus
              spellCheck={false}
              value={host}
              onChange={(e) => setHost(e.target.value.trim())}
              placeholder="mail.{domain}"
            />
          </Field>

          <div className="bulk__ports">
            <PortRow
              proto="imap"
              port={imapPort}
              security={imapSecurity}
              onPort={setImapPort}
              onSecurity={setImapSecurity}
            />
            <PortRow
              proto="smtp"
              port={smtpPort}
              security={smtpSecurity}
              onPort={setSmtpPort}
              onSecurity={setSmtpSecurity}
            />
          </div>
        </section>
      )}

      {step === 'mailboxes' && (
        <section className="bulk__step" aria-label="Mailboxes">
          <div className="bulk__sharedpw">
            <Toggle
              label="One password for all of them"
              checked={useShared}
              onChange={setUseShared}
            />
            <span className="bulk__sharedpw__label">One password for all of them</span>
            {useShared && (
              <input
                className="input"
                type="password"
                aria-label="Shared password"
                placeholder="••••••••"
                value={sharedPassword}
                onChange={(e) => setSharedPassword(e.target.value)}
              />
            )}
          </div>

          <div className="grid" role="table">
            <div className="grid__head" role="row">
              <span role="columnheader">Address</span>
              <span role="columnheader">{useShared ? '' : 'Password'}</span>
              <span role="columnheader">Priority</span>
              <span />
            </div>

            {rows.map((row, i) => (
              <div className="grid__row" role="row" key={row.key} data-status={row.status}>
                <input
                  className="input input--mono input--flush"
                  role="cell"
                  aria-label={`Address ${i + 1}`}
                  autoFocus={i === 0}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="you@yourdomain.com"
                  value={row.address}
                  data-invalid={
                    row.address.trim() &&
                    (!looksValid(row.address) || duplicates.has(row.address.trim().toLowerCase()))
                      ? true
                      : undefined
                  }
                  title={
                    duplicates.has(row.address.trim().toLowerCase())
                      ? 'This address appears more than once'
                      : undefined
                  }
                  onChange={(e) => patch(row.key, { address: e.target.value })}
                  onPaste={(e) => onPaste(row.key, e)}
                  onKeyDown={(e) => {
                    // Enter at the end of the grid adds a row, so a long list can
                    // be typed without reaching for the mouse.
                    if (e.key === 'Enter' && i === rows.length - 1) addRow();
                  }}
                />
                {useShared ? (
                  <span className="grid__muted">shared</span>
                ) : (
                  <input
                    className="input input--flush"
                    role="cell"
                    type="password"
                    aria-label={`Password ${i + 1}`}
                    autoComplete="off"
                    // Words, not dots. A dotted placeholder is indistinguishable
                    // from a filled field, so a row missing its password hides in
                    // plain sight.
                    placeholder={row.address.trim() ? 'needed' : ''}
                    data-missing={row.address.trim() && !row.password ? true : undefined}
                    value={row.password}
                    onChange={(e) => patch(row.key, { password: e.target.value })}
                    onPaste={(e) => onPaste(row.key, e)}
                  />
                )}
                <select
                  className="input input--flush input--mono"
                  role="cell"
                  aria-label={`Priority ${i + 1}`}
                  value={row.priority ?? ''}
                  onChange={(e) =>
                    patch(row.key, { priority: (e.target.value || null) as Priority | null })
                  }
                >
                  {/* The domain default, named, so the cell always states the
                      priority this mailbox will actually get. */}
                  <option value="">
                    {presets[domainOf(row.address)]?.priority ?? 'normal'} (domain)
                  </option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="grid__drop"
                  aria-label={`Remove row ${i + 1}`}
                  onClick={() => removeRow(row.key)}
                >
                  <Trash size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="bulk__gridfoot">
            <Button size="sm" onClick={addRow}>
              <Plus size={12} />
              Add row
            </Button>
            <span className="bulk__tally">
              {filled.length === 0
                ? 'nothing to import yet'
                : `${filled.length} mailbox${filled.length === 1 ? '' : 'es'}`}
              {domains.length > 0 && ` · ${domains.length} domain${domains.length === 1 ? '' : 's'}`}
              {invalid.length > 0 && (
                <span className="bulk__tally__bad"> · {invalid.length} not an address</span>
              )}
              {duplicates.size > 0 && (
                <span className="bulk__tally__bad"> · {duplicates.size} duplicated</span>
              )}
            </span>
          </div>

          <p className="bulk__hint">
            Paste a list to fill the grid at once — <code>address:password</code> per line, or just
            addresses if they share a password.
          </p>
        </section>
      )}

      {step === 'domains' && (
        <section className="bulk__step" aria-label="Domain settings">
          <p className="bulk__lede">
            Set each domain once. Every mailbox in it inherits this, so the sidebar arrives already
            tiered and coloured instead of grey.
          </p>

          <div className="dom">
            {domains.map((domain, i) => {
              const preset = presets[domain] ?? {
                priority: 'normal' as Priority,
                // Golden-angle spacing, the same rule the app uses when it
                // assigns colours itself, so a manual pick and an automatic one
                // are drawn from the same set.
                color: PALETTE[i % PALETTE.length]!,
              };
              const count = filled.filter((r) => domainOf(r.address) === domain).length;
              return (
                <div className="dom__row" key={domain}>
                  <div className="dom__id">
                    <span className="dom__chip" style={{ background: preset.color ?? undefined }} />
                    <span className="dom__name">{domain}</span>
                    <span className="dom__count">
                      {count} mailbox{count === 1 ? '' : 'es'}
                    </span>
                  </div>

                  <select
                    className="input input--mono"
                    aria-label={`Priority for ${domain}`}
                    value={preset.priority}
                    onChange={(e) =>
                      setPresets((p) => ({
                        ...p,
                        [domain]: { ...preset, priority: e.target.value as Priority },
                      }))
                    }
                  >
                    {PRIORITIES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>

                  <div className="swatches">
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="swatch"
                        aria-label={`${domain} colour ${c}`}
                        aria-pressed={preset.color === c}
                        style={{ '--tint': c } as React.CSSProperties}
                        onClick={() => setPresets((p) => ({ ...p, [domain]: { ...preset, color: c } }))}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {step === 'import' && (
        <section className="bulk__step" aria-label="Import progress">
          <div className="bulk__summary" data-done={done || undefined}>
            <div className="bulk__summary__nums">
              {/* Zero added is not good news, so it is not painted as good news. */}
              <Tally n={counts.ok} label="added" tone={counts.ok > 0 ? 'ok' : 'none'} />
              {counts.warn > 0 && <Tally n={counts.warn} label="cannot send" tone="warn" />}
              {counts.error > 0 && <Tally n={counts.error} label="failed" tone="error" />}
            </div>
            <div className="bulk__summary__state">
              {importing ? (
                <>
                  <Spinner />
                  <span>
                    Verifying and adding — {counts.ok + counts.warn + counts.error} of{' '}
                    {filled.filter((r) => looksValid(r.address)).length}
                  </span>
                </>
              ) : (
                <span>
                  {counts.error > 0
                    ? 'Fix the failures below and run them again, or finish and come back to it.'
                    : 'All done. Mail is syncing now.'}
                </span>
              )}
            </div>
          </div>

          <ul className="results">
            {rows
              .filter((r) => r.address.trim())
              .map((row) => (
                <li className="results__row" key={row.key} data-status={row.status}>
                  <span className="results__mark">
                    {row.status === 'working' && <Spinner />}
                    {row.status === 'ok' && <Check size={12} />}
                    {row.status === 'warn' && <Warning size={12} />}
                    {row.status === 'error' && <Close size={12} />}
                  </span>
                  <span className="results__addr">{row.address}</span>
                  <span className="results__msg">
                    {row.status === 'warn' ? `Receives, but cannot send: ${row.message}` : row.message}
                  </span>
                  {row.status === 'error' && (
                    <input
                      className="input input--flush results__retry"
                      type="password"
                      aria-label={`New password for ${row.address}`}
                      placeholder="new password"
                      value={row.password}
                      onChange={(e) => patch(row.key, { password: e.target.value })}
                    />
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}

      <footer className="bulk__foot">
        {step !== 'server' && step !== 'import' && (
          <Button
            variant="ghost"
            onClick={() => setStep(step === 'domains' ? 'mailboxes' : 'server')}
          >
            Back
          </Button>
        )}
        {step === 'import' && !importing && counts.error > 0 && (
          <Button variant="ghost" onClick={() => setStep('mailboxes')}>
            Back to the grid
          </Button>
        )}

        <span className="bulk__foot__spacer" />

        <Button variant="ghost" onClick={onClose}>
          {step === 'import' && !importing ? 'Close' : 'Cancel'}
        </Button>

        {step === 'server' && (
          <Button variant="primary" disabled={!host.trim()} onClick={() => setStep('mailboxes')}>
            Add mailboxes
          </Button>
        )}
        {step === 'mailboxes' && (
          <Button
            variant="primary"
            disabled={!filled.length || invalid.length > 0 || duplicates.size > 0 || missingPassword}
            onClick={() => setStep('domains')}
          >
            {!filled.length
              ? 'Add a mailbox'
              : invalid.length > 0 || duplicates.size > 0
                ? 'Fix the addresses'
                : missingPassword
                  ? 'Passwords needed'
                  : `Set up ${domains.length} domain${domains.length === 1 ? '' : 's'}`}
          </Button>
        )}
        {step === 'domains' && (
          <Button variant="primary" onClick={() => void run()}>
            Add {filled.length} mailbox{filled.length === 1 ? '' : 'es'}
          </Button>
        )}
        {step === 'import' && !importing && counts.error > 0 && (
          <Button variant="primary" onClick={() => void run()}>
            Retry {counts.error}
          </Button>
        )}
        {step === 'import' && !importing && counts.error === 0 && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              toast(`${counts.ok + counts.warn} mailboxes added`);
            }}
          >
            Done
          </Button>
        )}
      </footer>
    </div>
  );
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

function Steps({ step }: { step: Step }) {
  const order: Step[] = ['server', 'mailboxes', 'domains', 'import'];
  const names: Record<Step, string> = {
    server: 'Server',
    mailboxes: 'Mailboxes',
    domains: 'Domains',
    import: 'Import',
  };
  const current = order.indexOf(step);

  return (
    <div className="onb__steps">
      {order.map((s, i) => (
        <span key={s} style={{ display: 'contents' }}>
          <span
            className="onb__step"
            data-state={i < current ? 'done' : i === current ? 'current' : 'todo'}
          >
            <span className="onb__dot">{i < current ? <Check size={9} /> : i + 1}</span>
            {names[s]}
          </span>
          {i < order.length - 1 && <span className="onb__rule" />}
        </span>
      ))}
    </div>
  );
}

function PortRow({
  proto,
  port,
  security,
  onPort,
  onSecurity,
}: {
  proto: 'imap' | 'smtp';
  port: number;
  security: Security;
  onPort: (n: number) => void;
  onSecurity: (s: Security) => void;
}) {
  return (
    <div className="bulk__port">
      <span className="bulk__port__proto">{proto}</span>
      <input
        className="input input--mono"
        type="number"
        aria-label={`${proto} port`}
        value={port}
        onChange={(e) => onPort(Number(e.target.value))}
      />
      <Segmented
        value={security}
        onChange={onSecurity}
        ariaLabel={`${proto} security`}
        options={[
          { value: 'tls', label: 'TLS' },
          { value: 'starttls', label: 'STARTTLS' },
          { value: 'none', label: 'None' },
        ]}
      />
    </div>
  );
}

function Tally({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="tally" data-tone={tone}>
      <span className="tally__n tnum">{n}</span>
      <span className="tally__label">{label}</span>
    </span>
  );
}
