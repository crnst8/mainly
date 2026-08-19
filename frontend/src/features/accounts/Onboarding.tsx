/**
 * Add-account flow. Three stages, and the user only ever types two things:
 * their address and their password.
 *
 * Everything else — hosts, ports, TLS — is discovered and shown as a *result*,
 * not as a form to fill in. Manual fields exist, collapsed, for the cases
 * discovery gets wrong. Tesler's law: the complexity is real, it just does not
 * belong to the person adding an account.
 */

import { useEffect, useState } from 'react';
import { Check, Chevron, Close, Warning } from '@/components/icons';
import { Button, Field, Modal, Segmented, Spinner } from '@/components/ui';
import { getApi } from '@/lib/api';
import { domainOf } from '@/lib/format';
import { useStore } from '@/lib/store';
import type { Autoconfig, Priority, ServerConfig, VerifyResult } from '@/lib/types';
import { BulkOnboarding } from './BulkOnboarding';
import './onboarding.css';

type Stage = 'identify' | 'verify' | 'personalise' | 'done';

const PRIORITY_OPTIONS: { value: Priority; bars: number; desc: string }[] = [
  { value: 'critical', bars: 5, desc: 'Always first. Notifies.' },
  { value: 'high', bars: 4, desc: 'Above the fold.' },
  { value: 'normal', bars: 3, desc: 'Default ordering.' },
  { value: 'low', bars: 2, desc: 'Below everything else.' },
  { value: 'muted', bars: 1, desc: 'Synced, never surfaced.' },
];

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

export function Onboarding() {
  const close = () => useStore.getState().setOnboarding(false);
  const [mode, setMode] = useState<'one' | 'many'>('one');

  /**
   * Bulk gets its own modal geometry rather than sharing the wizard's.
   *
   * A four-column grid of forty-five rows does not belong in a 620px column, and
   * the footer belongs to whichever flow is running — the single wizard's says
   * "Test connection", bulk's says "Add 45 mailboxes", and neither makes sense in
   * the other. Two modals with a shared header is less machinery than one modal
   * that has to be told which flow it is in.
   */
  if (mode === 'many') {
    return (
      <Modal title="Add mailboxes" onClose={close} width={860}>
        <div className="onb">
          <ModeSwitch mode={mode} onChange={setMode} />
          <BulkOnboarding onClose={close} />
        </div>
      </Modal>
    );
  }

  return <SingleAccount mode={mode} onMode={setMode} />;
}

/** The two ways in, stated once so neither flow is a hidden branch of the other. */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: 'one' | 'many';
  onChange: (m: 'one' | 'many') => void;
}) {
  return (
    <div className="onb__mode">
      <Segmented
        value={mode}
        onChange={onChange}
        ariaLabel="How many mailboxes to add"
        options={[
          { value: 'one', label: 'One mailbox', hint: 'Servers discovered for you' },
          { value: 'many', label: 'Many at once', hint: 'One server, a grid of mailboxes' },
        ]}
      />
      <span className="onb__mode__hint">
        {mode === 'one'
          ? 'Type an address and we find the servers.'
          : 'For mailboxes that share a server — state it once, paste the rest.'}
      </span>
    </div>
  );
}

function SingleAccount({
  mode,
  onMode,
}: {
  mode: 'one' | 'many';
  onMode: (m: 'one' | 'many') => void;
}) {
  const close = () => useStore.getState().setOnboarding(false);
  const toast = useStore((s) => s.toast);
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);
  const sync = useStore((s) => s.sync);

  const [stage, setStage] = useState<Stage>('identify');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [label, setLabel] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [color, setColor] = useState<string | null>(null);

  const [config, setConfig] = useState<Autoconfig | null>(null);
  const [manual, setManual] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [newAccountId, setNewAccountId] = useState<string | null>(null);

  const domain = domainOf(address);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);

  /* Discovery runs as soon as the address looks complete — by the time the user
     has tabbed to the password field, the servers are usually already known. */
  useEffect(() => {
    if (!valid) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    const t = setTimeout(async () => {
      const api = await getApi();
      const found = await api.autoconfig(address).catch(() => null);
      if (cancelled) return;
      setConfig(found);
      setDetecting(false);
      if (found && found.confidence < 0.5) setManual(true);
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setDetecting(false);
    };
  }, [address, valid]);

  useEffect(() => {
    if (domain && !label) setLabel('');
    if (!displayName && valid) setDisplayName(address.split('@')[0]!.replace(/[._-]/g, ' '));
    if (!color && domain) setColor(prefs?.theme.domainColors[domain] ?? null);
  }, [address, domain, valid]);

  async function runVerify() {
    if (!config) return;
    setVerifying(true);
    const api = await getApi();
    const res = await api.verify({ address, password, imap: config.imap, smtp: config.smtp });
    setVerified(res);
    setVerifying(false);
    if (res.imap.ok && res.smtp.ok) setStage('personalise');
    else setManual(true);
  }

  async function create() {
    if (!config) return;
    const api = await getApi();
    const account = await api.createAccount({
      address,
      password,
      displayName: displayName.trim() || address,
      label: label.trim() || address,
      priority,
      imap: config.imap,
      smtp: config.smtp,
    });
    setNewAccountId(account.id);
    useStore.setState({ accounts: [...useStore.getState().accounts, account] });
    const folders = await api.listFolders();
    useStore.setState({ folders });

    if (color && prefs) {
      await savePrefs({
        theme: { ...prefs.theme, domainColors: { ...prefs.theme.domainColors, [domain]: color } },
      });
    }
    setStage('done');
  }

  const progress = newAccountId ? (sync.accounts[newAccountId]?.progress ?? 0) : 0;
  const step = newAccountId ? sync.accounts[newAccountId]?.step : null;

  return (
    <Modal
      title="Add an account"
      onClose={close}
      width={620}
      footer={
        <Footer
          stage={stage}
          canContinue={{
            identify: valid && password.length > 0 && !!config,
            verify: !!verified?.imap.ok,
            personalise: true,
            done: true,
          }[stage]}
          busy={verifying}
          onBack={() => setStage(stage === 'personalise' ? 'identify' : 'identify')}
          onNext={() => {
            if (stage === 'identify') void runVerify();
            else if (stage === 'personalise') void create();
            else {
              close();
              toast('Account added');
            }
          }}
        />
      }
    >
      <div className="onb">
        <ModeSwitch mode={mode} onChange={onMode} />
        <Steps stage={stage} />

        {stage === 'identify' && (
          <>
            <div className="onb__grid">
              <div className="onb__full">
                <Field label="Email address" hint={detecting ? 'Looking up servers…' : undefined}>
                  <input
                    className="input input--mono"
                    autoFocus
                    autoComplete="email"
                    spellCheck={false}
                    placeholder="you@yourdomain.com"
                    value={address}
                    onChange={(e) => setAddress(e.target.value.trim())}
                  />
                </Field>
              </div>
              <div className="onb__full">
                <Field
                  label="Password"
                  hint="Stored encrypted at rest. Never shown again."
                  error={verified && !verified.imap.ok ? verified.imap.error : null}
                >
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && valid && config && void runVerify()}
                  />
                </Field>
              </div>
            </div>

            {config && (
              <ServerCard
                config={config}
                verified={verified}
                verifying={verifying}
                manual={manual}
                onToggleManual={() => setManual((v) => !v)}
                onChange={(next) => setConfig({ ...config, ...next })}
              />
            )}
          </>
        )}

        {stage === 'personalise' && (
          <>
            <div className="onb__grid">
              <Field label="Label" hint="What you call it in the sidebar">
                <input
                  className="input"
                  autoFocus
                  placeholder={address}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </Field>
              <Field label="Display name" hint="Name on outgoing mail">
                <input
                  className="input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
            </div>

            <Field label="Priority" hint="Drives sort order and grouping">
              <div className="prio">
                {PRIORITY_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className="prio__opt"
                    aria-pressed={priority === o.value}
                    title={o.desc}
                    onClick={() => setPriority(o.value)}
                  >
                    <span className="prio__bars">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span
                          key={n}
                          className="prio__bar"
                          data-on={n <= o.bars}
                          style={{ height: 4 + n * 1.6 }}
                        />
                      ))}
                    </span>
                    <span className="prio__name">{o.value}</span>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Colour" hint={`Applies to everything from ${domain}`}>
              <div className="swatches">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="swatch"
                    aria-label={c}
                    aria-pressed={color === c}
                    style={{ '--tint': c } as React.CSSProperties}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </Field>
          </>
        )}

        {stage === 'done' && (
          <div className="onb__done">
            <span className="onb__done__mark">
              <Check size={20} />
            </span>
            <div>
              <div className="onb__done__title">{label || address}</div>
              <div className="onb__done__sub">{address}</div>
            </div>
            <div style={{ width: '100%', maxWidth: 320 }}>
              <div className="onb__syncline">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="onb__done__sub" style={{ marginTop: 'var(--s-4)' }}>
                {step ?? 'Starting sync…'}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ── Sub-components ───────────────────────────────────────────────────────── */

function Steps({ stage }: { stage: Stage }) {
  const order: Stage[] = ['identify', 'verify', 'personalise'];
  const names = { identify: 'Connect', verify: 'Verify', personalise: 'Set up', done: 'Done' };
  const current = stage === 'done' ? 3 : order.indexOf(stage);

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

function ServerCard({
  config,
  verified,
  verifying,
  manual,
  onToggleManual,
  onChange,
}: {
  config: Autoconfig;
  verified: VerifyResult | null;
  verifying: boolean;
  manual: boolean;
  onToggleManual: () => void;
  onChange: (next: Partial<Autoconfig>) => void;
}) {
  const SOURCE_LABEL: Record<Autoconfig['source'], string> = {
    srv: 'DNS SRV',
    autoconfig: 'autoconfig.xml',
    autodiscover: 'autodiscover',
    wellknown: 'well-known host',
    guess: 'guessed',
    known: 'already known',
  };

  const line = (proto: 'imap' | 'smtp') => {
    const cfg = config[proto];
    const state = verified?.[proto];
    return (
      <div className="detected__row" key={proto}>
        <span className="detected__proto">{proto}</span>
        <span className="detected__host">
          {cfg.host}:{cfg.port} · {cfg.security}
        </span>
        <span className="detected__state" data-ok={state ? state.ok : undefined}>
          {verifying ? (
            <Spinner />
          ) : state?.ok ? (
            <>
              <Check size={12} />
              {state.latencyMs}ms
            </>
          ) : state ? (
            <>
              <Close size={12} />
              failed
            </>
          ) : (
            'not tested'
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="detected">
      <div className="detected__head">
        <span className="label">Servers</span>
        <span className="detected__source">via {SOURCE_LABEL[config.source]}</span>
        <button type="button" className="btn btn--sm" onClick={onToggleManual}>
          {manual ? 'Hide' : 'Edit'}
          <Chevron size={11} dir={manual ? 'up' : 'down'} />
        </button>
      </div>

      {line('imap')}
      {line('smtp')}

      {verified && !verified.imap.ok && (
        <div className="detected__row" style={{ color: 'var(--danger)', gridTemplateColumns: '54px 1fr' }}>
          <Warning size={13} />
          <span style={{ overflowWrap: 'anywhere' }}>{verified.imap.error}</span>
        </div>
      )}

      {manual && (
        <div style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-5)' }}>
          {(['imap', 'smtp'] as const).map((proto) => (
            <div key={proto} style={{ display: 'grid', gridTemplateColumns: '1fr 78px 104px', gap: 'var(--s-3)' }}>
              <input
                className="input input--mono"
                aria-label={`${proto} host`}
                value={config[proto].host}
                onChange={(e) => onChange({ [proto]: { ...config[proto], host: e.target.value } } as Partial<Autoconfig>)}
              />
              <input
                className="input input--mono"
                aria-label={`${proto} port`}
                type="number"
                value={config[proto].port}
                onChange={(e) =>
                  onChange({ [proto]: { ...config[proto], port: Number(e.target.value) } } as Partial<Autoconfig>)
                }
              />
              <select
                className="input input--mono"
                aria-label={`${proto} security`}
                value={config[proto].security}
                onChange={(e) =>
                  onChange({
                    [proto]: { ...config[proto], security: e.target.value as ServerConfig['security'] },
                  } as Partial<Autoconfig>)
                }
              >
                <option value="tls">TLS</option>
                <option value="starttls">STARTTLS</option>
                <option value="none">None</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Footer({
  stage,
  canContinue,
  busy,
  onBack,
  onNext,
}: {
  stage: Stage;
  canContinue: boolean;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  const close = () => useStore.getState().setOnboarding(false);

  if (stage === 'done') {
    return (
      <Button variant="primary" onClick={close}>
        Done
      </Button>
    );
  }

  return (
    <>
      {stage === 'personalise' && (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canContinue || busy} onClick={onNext}>
        {busy ? <Spinner /> : null}
        {stage === 'identify' ? 'Test connection' : 'Add account'}
      </Button>
    </>
  );
}
