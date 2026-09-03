/**
 * Mail server — the settings screen for domain control.
 *
 * Named for the machine rather than "Domains", because in this app a domain is
 * already a presentation grouping in the sidebar, and two tabs a word apart
 * meaning unrelated things is how someone changes the wrong setting.
 *
 * The split of labour here is deliberate and is the security model made
 * visible:
 *
 *  - **Connecting** a domain installs an SSH key, and happens from a shell on
 *    the host (`./mainly.sh domain add`). Nothing on this screen can do it.
 *  - **Granting** happens here, because it is a decision someone makes while
 *    looking at what the mail server already permits.
 *  - **Using** it happens here too — see what exists, add an address, retire
 *    one — because that is the daily work, and a CLI for it would mean nobody
 *    ever revokes a grant they no longer need.
 *
 * A switch the mail server will refuse is shown off and disabled, with the
 * reason. Offering a button that fails teaches people to ignore the screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Field, IconButton, Modal, Row, Spinner, Toggle } from '@/components/ui';
import { Check, Close, Globe, Trash } from '@/components/icons';
import { relative } from '@/lib/format';
import { getApi } from '@/lib/api';
import {
  DOMAIN_GRANTS,
  DOMAIN_GRANT_LABELS,
  MIN_APP_PASSWORD,
  type DomainGrant,
  type DomainOp,
  type ManagedDomain,
  type ManagedMailbox,
} from '@/lib/types';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function MailServer() {
  const [domains, setDomains] = useState<ManagedDomain[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const api = await getApi();
      setDomains(await api.listDomains());
    } catch (err) {
      setFailure(message(err));
      setDomains([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!domains) return <Spinner />;

  if (!domains.length) {
    return (
      <>
        {failure && <p className="settings__note settings__note--error">{failure}</p>}
        <Empty
          title="No mail server connected"
          body={
            'This install can read your mail but not change what exists on the server. ' +
            'Connecting a domain lets it create and remove addresses — for one domain ' +
            'at a time, and only the operations you allow.'
          }
        />
        <section className="settings__section">
          <p className="settings__note">
            Connecting installs an SSH key, so it is done from a shell on this machine rather
            than from a browser:
          </p>
          <pre className="settings__code">
            ./mainly.sh domain add you@example.com example.com \{'\n'}
            {'  '}--host mail.example.com --key ~/.ssh/mainly_provision
          </pre>
          <p className="settings__note">
            The mail server needs <code>scripts/mainly-provision</code> installed first. See
            docs/domain-control.md — it takes about ten minutes, once per server.
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      {failure && <p className="settings__note settings__note--error">{failure}</p>}
      {domains.map((d) => (
        <DomainCard key={d.id} domain={d} onChanged={reload} />
      ))}
      <OpsLog />
    </>
  );
}

/* ── One domain ───────────────────────────────────────────────────────────── */

function DomainCard({ domain: d, onChanged }: { domain: ManagedDomain; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<ManagedMailbox[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ManagedMailbox | null>(null);

  const can = (g: DomainGrant) => d.effective.includes(g);

  const loadBoxes = useCallback(async () => {
    if (!can('list')) {
      setBoxes(null);
      return;
    }
    try {
      const api = await getApi();
      setBoxes(await api.listDomainMailboxes(d.id));
    } catch (err) {
      setFailure(message(err));
      setBoxes([]);
    }
    // `d.effective` rather than `d` — the list is refetched when what is
    // permitted changes, not when an unrelated field does.
  }, [d.id, d.effective]);

  useEffect(() => {
    void loadBoxes();
  }, [loadBoxes]);

  async function probe() {
    setBusy(true);
    setFailure(null);
    try {
      const api = await getApi();
      const result = await api.probeDomain(d.id);
      if (result.error) setFailure(result.error);
      else if (!result.parity) {
        setFailure(
          "This server's address list and password file disagree with each other. " +
            'Provisioning will refuse to run until that is fixed.',
        );
      }
      onChanged();
    } catch (err) {
      setFailure(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function setGrant(grant: DomainGrant, on: boolean) {
    const next = on ? [...d.grants, grant] : d.grants.filter((g) => g !== grant);
    // Purge is meaningless without delete, and the backend refuses the pair.
    // Kept in step here so the switch never lands in a state that cannot save.
    if (!on && grant === 'delete') {
      const i = next.indexOf('purge');
      if (i !== -1) next.splice(i, 1);
    }
    setBusy(true);
    setFailure(null);
    try {
      const api = await getApi();
      await api.updateDomainGrants(d.id, next);
      onChanged();
    } catch (err) {
      setFailure(message(err));
    } finally {
      setBusy(false);
    }
  }

  const unprobed = d.status === 'pending';

  return (
    <section className="settings__section mailsrv">
      <div className="mailsrv__head">
        <Globe size={15} />
        <div className="mailsrv__id">
          <div className="mailsrv__domain">{d.domain}</div>
          <div className="mailsrv__host">
            {d.config.user}@{d.config.host}
            {d.config.port !== 22 && `:${d.config.port}`}
          </div>
        </div>
        <span className="mailsrv__status" data-status={d.status}>
          {d.status}
        </span>
        <Button variant="outline" onClick={() => void probe()} disabled={busy}>
          {busy ? <Spinner /> : 'Check'}
        </Button>
      </div>

      {d.lastCheckedAt && (
        <p className="settings__note">Last checked {relative(d.lastCheckedAt)}.</p>
      )}
      {d.error && <p className="settings__note settings__note--error">{d.error}</p>}
      {failure && <p className="settings__note settings__note--error">{failure}</p>}

      {unprobed && (
        <p className="settings__note">
          Not checked yet. Press Check to find out what this server will allow.
        </p>
      )}

      {/* ── Grants ─────────────────────────────────────────────────────────── */}

      {DOMAIN_GRANTS.map((g) => {
        const allowedByServer = d.serverGrants.includes(g);
        const on = d.grants.includes(g);
        // Two reasons a switch is unavailable, and they are different problems
        // with different fixes, so they say different things.
        const blocked = unprobed
          ? 'Check the server first'
          : !allowedByServer
            ? 'Not permitted by the mail server'
            : g === 'purge' && !d.grants.includes('delete')
              ? 'Needs “Remove addresses” as well'
              : null;

        return (
          <Row key={g} title={DOMAIN_GRANT_LABELS[g]} desc={blocked ?? undefined}>
            {blocked ? (
              <span className="mailsrv__blocked" aria-label={blocked}>
                <Close size={13} />
              </span>
            ) : (
              <Toggle
                checked={on}
                onChange={(v) => void setGrant(g, v)}
                label={DOMAIN_GRANT_LABELS[g]}
              />
            )}
          </Row>
        );
      })}

      {/* ── Mailboxes ──────────────────────────────────────────────────────── */}

      {can('list') && (
        <div className="mailsrv__boxes">
          <div className="mailsrv__boxhead">
            <span className="label">Addresses on this server</span>
            {can('create') && (
              <Button variant="outline" onClick={() => setAdding(true)}>
                Add an address
              </Button>
            )}
          </div>

          {!boxes && <Spinner />}
          {boxes?.length === 0 && <p className="settings__note">None yet.</p>}
          {boxes?.map((b) => (
            <div key={b.address} className="mailsrv__box">
              <span className="mailsrv__boxaddr">{b.address}</span>
              {b.linked && (
                <span className="mailsrv__linked" title="Already synced by this install">
                  <Check size={12} /> synced
                </span>
              )}
              {can('delete') && (
                <IconButton label={`Remove ${b.address}`} onClick={() => setRemoving(b)}>
                  <Trash size={14} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <AddMailbox
          domain={d}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void loadBoxes();
          }}
        />
      )}

      {removing && (
        <RemoveMailbox
          domain={d}
          mailbox={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void loadBoxes();
          }}
        />
      )}
    </section>
  );
}

/* ── Add ──────────────────────────────────────────────────────────────────── */

/**
 * Creating an address offers to add the mailbox to this install in the same
 * step, because this is the one moment the password is known. Making the
 * operator retype it into the account form immediately afterwards is the kind
 * of friction that ends in a reused password.
 */
function AddMailbox({
  domain: d,
  onClose,
  onDone,
}: {
  domain: ManagedDomain;
  onClose: () => void;
  onDone: () => void;
}) {
  const [localpart, setLocalpart] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const address = `${localpart || '…'}@${d.domain}`;
  const valid = /^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localpart);

  async function create() {
    setBusy(true);
    setFailure(null);
    try {
      const api = await getApi();
      await api.createDomainMailbox(d.id, { localpart, password });
      onDone();
    } catch (err) {
      setFailure(message(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`New address on ${d.domain}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy || password.length < MIN_APP_PASSWORD} onClick={() => void create()}>
            {busy ? <Spinner /> : `Create ${address}`}
          </Button>
        </>
      }
    >
      <Field
        label="Address"
        hint={d.domain}
        error={localpart && !valid ? 'Lowercase letters, digits, dot, underscore, plus and hyphen.' : null}
      >
        <input
          className="input"
          value={localpart}
          autoFocus
          onChange={(e) => setLocalpart(e.target.value.trim().toLowerCase())}
          placeholder="hello"
        />
      </Field>

      <Field
        label="Password"
        hint="Generated. Copy it now — the server stores only a hash."
        error={password.length < MIN_APP_PASSWORD ? `At least ${MIN_APP_PASSWORD} characters.` : null}
      >
        <div className="mailsrv__pwrow">
          <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button variant="outline" onClick={() => setPassword(generatePassword())}>
            New
          </Button>
        </div>
      </Field>

      {failure && <p className="settings__note settings__note--error">{failure}</p>}
    </Modal>
  );
}

/* ── Remove ───────────────────────────────────────────────────────────────── */

/**
 * Two decisions, asked separately.
 *
 * Retiring an address is reversible — recreate it and mail flows again. Purging
 * the Maildir destroys years of mail and is not. They are not the same question
 * and this does not let one imply the other: the address must be typed back,
 * and purge is a second, explicitly-off switch.
 */
function RemoveMailbox({
  domain: d,
  mailbox,
  onClose,
  onDone,
}: {
  domain: ManagedDomain;
  mailbox: ManagedMailbox;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirmed = typed.trim().toLowerCase() === mailbox.address;
  const canPurge = d.effective.includes('purge');

  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      const api = await getApi();
      await api.deleteDomainMailbox(d.id, mailbox.localpart, purge);
      onDone();
    } catch (err) {
      setFailure(message(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Remove ${mailbox.address}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!confirmed || busy} onClick={() => void remove()}>
            {busy ? <Spinner /> : purge ? 'Remove and destroy the mail' : 'Remove the address'}
          </Button>
        </>
      }
    >
      <p className="settings__note">
        {purge
          ? 'The address stops receiving mail, and everything already delivered to it is deleted from the server. This cannot be undone.'
          : 'The address stops receiving mail. Everything already delivered to it stays on the server, and recreating the address brings it back.'}
      </p>

      {mailbox.linked && (
        <p className="settings__note settings__note--error">
          This install still syncs this address. Remove the account too, or it will start
          reporting a sign-in failure.
        </p>
      )}

      <Field label="Type the address to confirm" hint={mailbox.address}>
        <input
          className="input"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          placeholder={mailbox.address}
        />
      </Field>

      {canPurge && (
        <Row
          title="Also delete the stored mail"
          desc="Permanent. Leave this off unless you mean it."
        >
          <Toggle checked={purge} onChange={setPurge} label="Also delete the stored mail" />
        </Row>
      )}

      {failure && <p className="settings__note settings__note--error">{failure}</p>}
    </Modal>
  );
}

/* ── Audit ────────────────────────────────────────────────────────────────── */

function OpsLog() {
  const [ops, setOps] = useState<DomainOp[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || ops) return;
    void (async () => {
      const api = await getApi();
      setOps(await api.listDomainOps(50).catch(() => []));
    })();
  }, [open, ops]);

  return (
    <section className="settings__section">
      <Row title="History" desc="Every change this install made to a mail server, and every one it tried to.">
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </Row>

      {open && !ops && <Spinner />}
      {open && ops?.length === 0 && <p className="settings__note">Nothing yet.</p>}
      {open &&
        ops?.map((o) => (
          <div key={o.id} className="mailsrv__op" data-failed={o.status === 'failed' || undefined}>
            <span className="mailsrv__opwhen">{relative(o.createdAt)}</span>
            <span className="mailsrv__opwhat">
              {o.action} {o.target}
            </span>
            <span className="mailsrv__opwho">{o.actor}</span>
            {o.detail && <span className="mailsrv__opdetail">{o.detail}</span>}
          </div>
        ))}
    </section>
  );
}

/** Unambiguous alphabet: no l/I/1, no O/0. These get read off a screen and
 *  typed into a phone's mail settings. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
