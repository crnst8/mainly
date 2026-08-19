/**
 * Settings. Full-screen rather than a modal: this is where the app is shaped,
 * and the panes are wide enough that a dialog would fight them.
 *
 * Every control writes through to `applyTheme` immediately — no Save button,
 * no preview/apply split. You change a colour, the app is that colour.
 */

import { useState } from 'react';
import {
  Chevron,
  Close,
  Command,
  Globe,
  Layout,
  Palette as PaletteIcon,
  Search as SearchIcon,
  Trash,
  User,
} from '@/components/icons';
import { Button, Field, IconButton, Row, Segmented, Spinner, Toggle } from '@/components/ui';
import { SHORTCUTS } from '@/lib/keyboard';
import { relative } from '@/lib/format';
import { DEFAULT_SEARCH_WEIGHTS, type SearchWeights } from '@/lib/search';
import { useDomains, useStore } from '@/lib/store';
import type { Account, Density, ListColumn, Priority, ThemeMode } from '@/lib/types';
import './settings.css';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon size={15} /> },
  { id: 'colours', label: 'Colours', icon: <Globe size={15} /> },
  { id: 'list', label: 'Message list', icon: <Layout size={15} /> },
  { id: 'search', label: 'Search', icon: <SearchIcon size={15} /> },
  { id: 'accounts', label: 'Accounts', icon: <User size={15} /> },
  { id: 'keyboard', label: 'Keyboard', icon: <Command size={15} /> },
];

const ACCENTS = [
  'oklch(62% 0.19 258)',
  'oklch(58% 0.2 292)',
  'oklch(64% 0.19 28)',
  'oklch(60% 0.15 168)',
  'oklch(68% 0.17 88)',
  'oklch(60% 0.21 338)',
  // Achromatic option. Mid-grey rather than near-black so it stays visible in
  // both themes — a black swatch on a black surface is not a choice.
  'oklch(52% 0 0)',
];

export function Settings() {
  const raw = useStore((s) => s.settings) ?? 'appearance';
  const setSettings = useStore((s) => s.setSettings);
  const [tab, setTab] = useState(raw.startsWith('account:') ? 'accounts' : raw);
  const prefs = useStore((s) => s.prefs);

  if (!prefs) return null;

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings__nav">
        {/* The way out, in the position the app's wordmark occupies everywhere
            else — the app's home control. This was a static "Settings" label:
            dead text exactly where every other screen puts the control that
            takes you back. */}
        <button type="button" className="settings__back" onClick={() => setSettings(null)}>
          <Chevron size={13} dir="left" />
          <span>Mainly</span>
        </button>
        <div className="settings__brand">Settings</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="settings__navitem"
            aria-current={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="settings__main">
        <div className="settings__head">
          {/* Shown only where the nav is hidden. Below 860px the sidebar — and
              with it the back control and every tab — is display:none, which
              left an unlabelled 28px icon in the far corner as the sole exit. */}
          <button
            type="button"
            className="settings__back settings__back--inline"
            onClick={() => setSettings(null)}
          >
            <Chevron size={13} dir="left" />
            <span>Mainly</span>
          </button>
          <h1 className="settings__title">{TABS.find((t) => t.id === tab)?.label}</h1>
          <IconButton label="Close settings" hint="Esc" onClick={() => setSettings(null)}>
            <Close size={16} />
          </IconButton>
        </div>

        <div className="settings__scroll">
          <div className="settings__pane">
            {tab === 'appearance' && <Appearance />}
            {tab === 'colours' && <Colours />}
            {tab === 'list' && <ListSettings />}
            {tab === 'search' && <SearchSettings />}
            {tab === 'accounts' && <Accounts focus={raw.startsWith('account:') ? raw.slice(8) : null} />}
            {tab === 'keyboard' && <Keyboard />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Appearance ───────────────────────────────────────────────────────────── */

function Appearance() {
  const theme = useStore((s) => s.prefs!.theme);
  const saveTheme = useStore((s) => s.saveTheme);

  return (
    <>
      <ThemePreview />

      <section className="settings__section">
        <Row title="Mode" desc="System follows your OS setting.">
          <Segmented<ThemeMode>
            ariaLabel="Theme mode"
            value={theme.mode}
            onChange={(mode) => void saveTheme({ mode })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>

        <Row title="Accent" desc="Unread marks, focus rings, selection, links.">
          <div className="colorrow__swatches">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                aria-label={c}
                aria-pressed={theme.accent === c}
                style={{ '--tint': c } as React.CSSProperties}
                onClick={() => void saveTheme({ accent: c })}
              />
            ))}
            <input
              type="color"
              className="colorinput"
              aria-label="Custom accent"
              onChange={(e) => void saveTheme({ accent: e.target.value })}
            />
          </div>
        </Row>

        <Row title="Density" desc="How much vertical space each row gets.">
          <Segmented<Density>
            ariaLabel="Density"
            value={theme.density}
            onChange={(density) => void saveTheme({ density })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'cosy', label: 'Cosy' },
              { value: 'relaxed', label: 'Relaxed' },
            ]}
          />
        </Row>

        <Row title="Corner radius" desc="0 is fully flat.">
          <Slider
            min={0}
            max={12}
            value={theme.radius}
            suffix="px"
            onChange={(radius) => void saveTheme({ radius })}
          />
        </Row>

        <Row title="Contrast" desc="High darkens borders and secondary text.">
          <Segmented
            ariaLabel="Contrast"
            value={theme.contrast}
            onChange={(contrast) => void saveTheme({ contrast })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Row>

        <Row title="Text size" desc="Scales the whole interface.">
          <Slider
            min={0.85}
            max={1.25}
            step={0.05}
            value={theme.fontScale}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(fontScale) => void saveTheme({ fontScale })}
          />
        </Row>

        <Row title="Reduce motion" desc="Removes transitions beyond the OS setting.">
          <Toggle
            label="Reduce motion"
            checked={theme.reduceMotion}
            onChange={(reduceMotion) => void saveTheme({ reduceMotion })}
          />
        </Row>
      </section>
    </>
  );
}

/** Live sample of the list under the current tokens. Changes land here first. */
function ThemePreview() {
  const domains = useDomains();
  const prefs = useStore((s) => s.prefs!);
  const tints = domains.slice(0, 3).map((d) => prefs.theme.domainColors[d.domain] ?? 'var(--n-5)');

  return (
    <div className="preview">
      <div className="preview__bar">
        <span className="label">Inbox</span>
        <span className="label" style={{ marginLeft: 'auto' }}>
          128
        </span>
      </div>
      {[0, 1, 2].map((i) => (
        <div className="preview__row" key={i} style={{ '--tint': tints[i] } as React.CSSProperties}>
          <span className="preview__stripe" />
          <span className="preview__dot" style={{ opacity: i === 0 ? 1 : 0 }} />
          <span className="preview__bars">
            <span className="preview__bar preview__bar--strong" style={{ width: `${52 - i * 12}%` }} />
            <span className="preview__bar" style={{ width: `${78 - i * 9}%` }} />
          </span>
          <span className="label tnum">{['14:22', 'Tue', '3 Mar'][i]}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Colours ──────────────────────────────────────────────────────────────── */

function Colours() {
  const domains = useDomains();
  const prefs = useStore((s) => s.prefs!);
  const saveTheme = useStore((s) => s.saveTheme);
  const accounts = useStore((s) => s.accounts);
  const updateAccount = useStore((s) => s.updateAccount);

  const setDomain = (domain: string, color: string) =>
    void saveTheme({ domainColors: { ...prefs.theme.domainColors, [domain]: color } });

  const FOLDER_ROLES = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'] as const;

  return (
    <>
      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Domains</span>
        </div>
        <p className="field__hint" style={{ marginBottom: 'var(--s-5)' }}>
          Each domain gets a colour. It shows on the rail, the row stripe, and every badge for that
          domain. Accounts inherit unless overridden below.
        </p>
        {domains.map(({ domain, accounts: list }) => (
          <div className="colorrow" key={domain}>
            <input
              type="color"
              className="colorinput"
              aria-label={`${domain} colour`}
              onChange={(e) => setDomain(domain, e.target.value)}
            />
            <span className="colorrow__name">
              {domain}
              <span className="colorrow__addr" style={{ display: 'block' }}>
                {list.length} account{list.length > 1 ? 's' : ''}
              </span>
            </span>
            <div className="colorrow__swatches">
              {[20, 88, 168, 218, 258, 292, 338].map((h) => {
                const c = `oklch(64% 0.16 ${h})`;
                return (
                  <button
                    key={h}
                    type="button"
                    className="swatch"
                    aria-label={`hue ${h}`}
                    aria-pressed={prefs.theme.domainColors[domain] === c}
                    style={{ '--tint': c } as React.CSSProperties}
                    onClick={() => setDomain(domain, c)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Account overrides</span>
        </div>
        {accounts.map((a) => (
          <div className="colorrow" key={a.id}>
            <input
              type="color"
              className="colorinput"
              aria-label={`${a.address} colour`}
              onChange={(e) => void updateAccount(a.id, { color: e.target.value })}
            />
            <span className="colorrow__name">
              {a.label}
              <span className="colorrow__addr" style={{ display: 'block' }}>
                {a.address}
              </span>
            </span>
            {a.color && (
              <Button size="sm" onClick={() => void updateAccount(a.id, { color: null })}>
                Reset to domain
              </Button>
            )}
          </div>
        ))}
      </section>

      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Folders</span>
        </div>
        {FOLDER_ROLES.map((role) => (
          <div className="colorrow" key={role}>
            <input
              type="color"
              className="colorinput"
              aria-label={`${role} colour`}
              onChange={(e) =>
                void saveTheme({ folderColors: { ...prefs.theme.folderColors, [role]: e.target.value } })
              }
            />
            <span className="colorrow__name" style={{ textTransform: 'capitalize' }}>
              {role}
            </span>
            {prefs.theme.folderColors[role] && (
              <Button
                size="sm"
                onClick={() => {
                  const next = { ...prefs.theme.folderColors };
                  delete next[role];
                  void saveTheme({ folderColors: next });
                }}
              >
                Reset
              </Button>
            )}
          </div>
        ))}
      </section>
    </>
  );
}

/* ── Message list ─────────────────────────────────────────────────────────── */

const COLUMN_LABELS: Record<ListColumn, string> = {
  stripe: 'Account stripe',
  select: 'Checkbox',
  unread: 'Unread dot',
  flag: 'Flag',
  avatar: 'Monogram',
  sender: 'Sender',
  subject: 'Subject',
  preview: 'Preview text',
  labels: 'Labels',
  account: 'Account name',
  attachment: 'Attachment mark',
  size: 'Size',
  date: 'Date',
};

function ListSettings() {
  const prefs = useStore((s) => s.prefs!);
  const savePrefs = useStore((s) => s.savePrefs);

  const toggleColumn = (c: ListColumn) =>
    void savePrefs({
      listColumns: prefs.listColumns.includes(c)
        ? prefs.listColumns.filter((x) => x !== c)
        : [...prefs.listColumns, c],
    });

  return (
    <>
      <section className="settings__section">
        <Row title="Preview pane" desc="Where the open message appears.">
          <Segmented
            ariaLabel="Preview pane"
            value={prefs.preview}
            onChange={(preview) => void savePrefs({ preview })}
            options={[
              { value: 'right', label: 'Right' },
              { value: 'bottom', label: 'Bottom' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>

        <Row title="Default sort" desc="Applied when the app opens.">
          <Segmented
            ariaLabel="Default sort"
            value={prefs.defaultQuery.sort}
            onChange={(sort) => void savePrefs({ defaultQuery: { ...prefs.defaultQuery, sort } })}
            options={[
              { value: 'date', label: 'Date' },
              { value: 'priority', label: 'Priority' },
              { value: 'unread', label: 'Unread' },
            ]}
          />
        </Row>

        <Row title="Default grouping" desc="How rows are chunked.">
          <Segmented
            ariaLabel="Default grouping"
            value={prefs.defaultQuery.group}
            onChange={(group) => void savePrefs({ defaultQuery: { ...prefs.defaultQuery, group } })}
            options={[
              { value: 'date', label: 'Date' },
              { value: 'account', label: 'Account' },
              { value: 'priority', label: 'Priority' },
              { value: 'none', label: 'None' },
            ]}
          />
        </Row>

        <Row title="Collapse threads" desc="One row per conversation.">
          <Toggle
            label="Collapse threads"
            checked={prefs.defaultQuery.threaded}
            onChange={(threaded) => void savePrefs({ defaultQuery: { ...prefs.defaultQuery, threaded } })}
          />
        </Row>
      </section>

      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Row contents</span>
        </div>
        <div className="columns" style={{ marginTop: 'var(--s-5)' }}>
          {(Object.keys(COLUMN_LABELS) as ListColumn[]).map((c) => (
            <button
              key={c}
              type="button"
              className="column-chip"
              aria-pressed={prefs.listColumns.includes(c)}
              onClick={() => toggleColumn(c)}
            >
              {COLUMN_LABELS[c]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <Row title="Mark read after" desc="Time a message must stay open before it counts as read.">
          <Slider
            min={-1}
            max={5000}
            step={100}
            value={prefs.markReadDelayMs}
            format={(v) => (v < 0 ? 'Never' : v === 0 ? 'Instant' : `${(v / 1000).toFixed(1)}s`)}
            onChange={(markReadDelayMs) => void savePrefs({ markReadDelayMs })}
          />
        </Row>

        <Row title="Undo window" desc="How long archive and delete stay reversible.">
          <Slider
            min={2000}
            max={20000}
            step={1000}
            value={prefs.undoWindowMs}
            format={(v) => `${v / 1000}s`}
            onChange={(undoWindowMs) => void savePrefs({ undoWindowMs })}
          />
        </Row>

        <Row title="Remote images" desc="Loading them tells senders when you opened a message.">
          <Segmented
            ariaLabel="Remote images"
            value={prefs.remoteImages}
            onChange={(remoteImages) => void savePrefs({ remoteImages })}
            options={[
              { value: 'never', label: 'Block' },
              { value: 'trusted', label: 'Trusted' },
              { value: 'always', label: 'Always' },
            ]}
          />
        </Row>

        <Row title="Send guards" desc="Warn on an empty subject or a missing attachment.">
          <Toggle
            label="Send guards"
            checked={prefs.sendGuards}
            onChange={(sendGuards) => void savePrefs({ sendGuards })}
          />
        </Row>
      </section>
    </>
  );
}

/* ── Search ───────────────────────────────────────────────────────────────── */

/**
 * The ranking dials.
 *
 * Every slider is a multiplier on the profile the query's intent selected: 0
 * removes the signal, 1 is what the app ships with, 2 doubles its pull. That is
 * the whole model, so the labels say "Off / Normal / Strong" rather than
 * printing a number nobody can calibrate against.
 *
 * The intent list below is not decoration. Adaptive ranking is invisible by
 * construction — the only way to know why a result moved is to be told what the
 * app decided the query was for.
 */
const WEIGHT_ROWS: { key: keyof SearchWeights; title: string; desc: string }[] = [
  { key: 'subject', title: 'Subject', desc: 'How much a match in the subject line counts.' },
  { key: 'sender', title: 'Sender', desc: 'How much a match in the sender name or address counts.' },
  { key: 'preview', title: 'Preview text', desc: 'How much a match in the stored preview counts.' },
  { key: 'recency', title: 'Recency', desc: 'How far newer mail is pulled above older mail. Off ranks on text alone.' },
  {
    key: 'accountPriority',
    title: 'Account priority',
    desc: 'How far an account’s tier — critical through muted — moves its results.',
  },
  { key: 'unread', title: 'Unread and flagged', desc: 'How far unread or flagged mail is lifted.' },
  {
    key: 'demoteNoise',
    title: 'Demote junk and trash',
    desc: 'How hard results in junk, trash and drafts are pushed down.',
  },
];

const INTENT_ROWS: { name: string; when: string; does: string }[] = [
  { name: 'Person', when: 'from: or to: leads the query', does: 'Sender outweighs subject.' },
  { name: 'File', when: 'has:attachment, larger:, smaller:', does: 'Attachments lift; age barely counts.' },
  { name: 'Phrase', when: 'a "quoted phrase"', does: 'Old exact matches keep their score.' },
  { name: 'Subject', when: 'subject: with no loose words', does: 'Subject only; the rest is muted.' },
  { name: 'Dated', when: 'before: or after:', does: 'You set the window, so age stops re-sorting.' },
  { name: 'Sweep', when: 'only is: / has: filters', does: 'Nothing to rank, so newest wins.' },
];

const dialLabel = (v: number) => (v === 0 ? 'Off' : v === 1 ? 'Normal' : `×${v.toFixed(1)}`);

function SearchSettings() {
  const search = useStore((s) => s.prefs!.search);
  const savePrefs = useStore((s) => s.savePrefs);

  const setWeight = (key: keyof SearchWeights, value: number) =>
    void savePrefs({ search: { ...search, weights: { ...search.weights, [key]: value } } });

  const isDefault = WEIGHT_ROWS.every((r) => search.weights[r.key] === DEFAULT_SEARCH_WEIGHTS[r.key]);

  return (
    <>
      <section className="settings__section">
        <Row
          title="Adapt to the query"
          desc="Read what the query is for — a person, a file, a phrase, a date range — and rank accordingly. Off treats every search the same way."
        >
          <Toggle
            label="Adapt ranking to the query"
            checked={search.adaptive}
            onChange={(adaptive) => void savePrefs({ search: { ...search, adaptive } })}
          />
        </Row>
      </section>

      {search.adaptive && (
        <section className="settings__section">
          <div className="settings__sectionhead">
            <span className="label">What each query type changes</span>
          </div>
          <dl className="intents">
            {INTENT_ROWS.map((i) => (
              <div key={i.name} className="intents__row">
                <dt className="intents__name">{i.name}</dt>
                <dd className="intents__when">{i.when}</dd>
                <dd className="intents__does">{i.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="settings__section">
        <div className="settings__sectionhead settings__sectionhead--split">
          <span className="label">Priorities</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault}
            onClick={() =>
              void savePrefs({ search: { ...search, weights: { ...DEFAULT_SEARCH_WEIGHTS } } })
            }
          >
            Reset
          </Button>
        </div>

        {WEIGHT_ROWS.map((r) => (
          <Row key={r.key} title={r.title} desc={r.desc}>
            <Slider
              min={0}
              max={2}
              step={0.1}
              value={search.weights[r.key]}
              format={dialLabel}
              onChange={(v) => setWeight(r.key, Math.round(v * 10) / 10)}
            />
          </Row>
        ))}
      </section>

      <section className="settings__section">
        <p className="settings__note">
          Message bodies are not indexed yet, so search covers the subject, the sender and the
          stored 200-character preview. These weights apply to those three.
        </p>
      </section>
    </>
  );
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low', 'muted'];

function Accounts({ focus }: { focus: string | null }) {
  const accounts = useStore((s) => s.accounts);
  const setOnboarding = useStore((s) => s.setOnboarding);

  return (
    <>
      <section className="settings__section">
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} focused={focus === a.id} />
        ))}
      </section>

      <Button variant="outline" onClick={() => setOnboarding(true)}>
        Add another account
      </Button>
    </>
  );
}

/**
 * One mailbox.
 *
 * The repair affordances live here because this is where the sidebar's
 * "fix credentials" link lands. Until they existed that link opened a page
 * showing the error and offering no way to act on it — which is worse than no
 * link, because it promises a fix and delivers a dead end. With forty-five
 * mailboxes, a password going stale is routine maintenance, not an edge case.
 */
function AccountRow({ account: a, focused }: { account: Account; focused: boolean }) {
  const prefs = useStore((s) => s.prefs!);
  const updateAccount = useStore((s) => s.updateAccount);
  const updatePassword = useStore((s) => s.updateAccountPassword);
  const removeAccount = useStore((s) => s.removeAccount);

  const broken = a.status === 'auth_error' || a.status === 'connect_error';
  const tint = a.color ?? prefs.theme.domainColors[a.domain] ?? 'var(--n-5)';

  // Opened automatically for a broken account: arriving from the sidebar link
  // and still having to find the button is the same dead end one click later.
  const [repairing, setRepairing] = useState(broken);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function save() {
    if (!password) return;
    setSaving(true);
    setFailure(null);
    const error = await updatePassword(a.id, password);
    setSaving(false);
    if (error) {
      setFailure(error);
      return;
    }
    setPassword('');
    setRepairing(false);
  }

  return (
    <div
      className="acctrow"
      data-broken={broken || undefined}
      style={{
        '--tint': tint,
        ...(focused ? { borderColor: 'var(--accent)' } : {}),
      } as React.CSSProperties}
    >
      <span className="acctrow__stripe" />

      <div className="acctrow__id">
        <div className="acctrow__label">{a.label}</div>
        <div className="acctrow__addr">{a.address}</div>
        {broken && a.error && <div className="acctrow__err">{a.error}</div>}
      </div>

      <Segmented<Priority>
        ariaLabel={`Priority for ${a.address}`}
        value={a.priority}
        onChange={(priority) => void updateAccount(a.id, { priority })}
        options={PRIORITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase(), hint: p }))}
      />

      <span className="acctrow__status" data-error={broken}>
        {broken ? 'error' : a.lastSyncAt ? relative(a.lastSyncAt) : 'never synced'}
      </span>

      <Toggle
        label={`Show ${a.address} in unified views`}
        checked={!a.hidden}
        onChange={(v) => void updateAccount(a.id, { hidden: !v })}
      />

      <div className="acctrow__acts">
        <Button size="sm" onClick={() => setRepairing((v) => !v)}>
          {repairing ? 'Cancel' : 'Password'}
        </Button>
        <IconButton
          label={`Remove ${a.address}`}
          hint="Remove this mailbox"
          onClick={() => setConfirmRemove(true)}
        >
          <Trash size={14} />
        </IconButton>
      </div>

      {repairing && (
        <form
          className="acctrow__repair"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="New password"
            hint="Verified against the server before it is stored."
            error={failure}
          >
            <input
              className="input"
              type="password"
              autoFocus
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!password || saving}>
            {saving ? <Spinner /> : null}
            {saving ? 'Checking' : 'Verify and save'}
          </Button>
        </form>
      )}

      {confirmRemove && (
        <div className="acctrow__confirm">
          {/* Not an undo-window action. Removing an account discards its whole
              local index, which cannot be un-deleted the way a moved message
              can — so this is the one place a confirm is the right pattern. */}
          <span>
            Remove <strong>{a.address}</strong>? Its mail on the server is untouched; the local
            copy and its settings are discarded.
          </span>
          <div className="acctrow__confirm__acts">
            <Button size="sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button size="sm" variant="danger" onClick={() => void removeAccount(a.id)}>
              Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Keyboard ─────────────────────────────────────────────────────────────── */

function Keyboard() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="keys">
      {groups.map((g) => (
        <section key={g}>
          <div className="settings__sectionhead">
            <span className="label">{g}</span>
          </div>
          {SHORTCUTS.filter((s) => s.group === g).map((s) => (
            <div className="keys__row" key={s.label}>
              <span>{s.label}</span>
              <span className="keys__combo">
                {s.keys.map((k, i) => (
                  <kbd className="kbd" key={i}>
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/* ── Slider ───────────────────────────────────────────────────────────────── */

function Slider({
  min,
  max,
  step = 1,
  value,
  suffix,
  format,
  onChange,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  suffix?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="sliderwrap">
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slidervalue">{format ? format(value) : `${value}${suffix ?? ''}`}</span>
    </div>
  );
}
