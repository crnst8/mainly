import { Check, Chevron, Command, Inbox, Plus, Refresh, Undo } from '@/components/icons';
import { Button, IconButton, Kbd, PopLabel, Popover } from '@/components/ui';
import { useKeyboard } from '@/lib/keyboard';
import { useRouter } from '@/lib/router';
import { useAccountColor, useStore } from '@/lib/store';
import { Composer } from '@/features/compose/Composer';
import { MailList } from '@/features/mail-list/MailList';
import { Onboarding } from '@/features/accounts/Onboarding';
import { Reader } from '@/features/reader/Reader';
import { Settings } from '@/features/settings/Settings';
import { CommandPalette } from './CommandPalette';
import { SearchBox } from './SearchBox';
import { Rail } from './Rail';
import { Sidebar } from './Sidebar';
import './shell.css';

export function AppShell() {
  useKeyboard();
  useRouter();
  const preview = useStore((s) => s.prefs?.preview ?? 'right');
  const openId = useStore((s) => s.openId);
  const settings = useStore((s) => s.settings);
  const onboarding = useStore((s) => s.onboarding);

  return (
    <div className="app">
      <Topbar />
      <div className="app__body" data-preview={preview} data-reader={openId ? 'open' : 'closed'}>
        <Rail />
        <Sidebar />
        <MailList />
        <Reader />
      </div>

      <Composer />
      <CommandPalette />
      <Toasts />
      {settings && <Settings />}
      {onboarding && <Onboarding />}
    </div>
  );
}

/* ── Topbar ───────────────────────────────────────────────────────────────── */

function Topbar() {
  const compose = useStore((s) => s.compose);
  const setPalette = useStore((s) => s.setPalette);
  const refresh = useStore((s) => s.refresh);
  const goHome = useStore((s) => s.goHome);
  const atHome = useStore((s) => s.query.scope.kind === 'unified' && s.query.scope.role === 'inbox');
  const busy = useStore((s) => s.sync.busy);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        {/* The wordmark is the way home. It is a control, so it looks and
            behaves like one — hover, focus ring, pressed state, and a title
            that names the destination rather than the product. */}
        <button
          type="button"
          className="topbar__mark"
          aria-label="All mail"
          aria-current={atHome}
          title="All mail · g h"
          onClick={goHome}
        >
          {/* Both variants ship and CSS picks one, rather than swapping `src`
              from JS. index.html resolves the theme onto `data-theme` before the
              first paint, so the right mark is correct on frame one — a JS swap
              would show the wrong one until React mounted. `alt` is empty
              because the button already carries the accessible name; announcing
              "logo" after "All mail" is noise.

              BASE_URL, not a bare "/…": Vite rewrites asset paths in index.html
              and in CSS url(), but a string literal in JSX is opaque to it. A
              build mounted anywhere other than the site root — the hosted demo
              lives at /demo/ — then asks the origin for /logo/… and gets a 404,
              which is a broken mark on every screen. BASE_URL is "/" for a
              self-hosted install, so this costs that case nothing. */}
          <img
            className="topbar__logo"
            src={`${import.meta.env.BASE_URL}logo/logo-128.png`}
            alt=""
            width={20}
            height={20}
          />
          <img
            className="topbar__logo topbar__logo--dark"
            src={`${import.meta.env.BASE_URL}logo/logo-light-128.png`}
            alt=""
            width={20}
            height={20}
          />
          <span>mainly</span>
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SearchBox />
      </div>

      <div className="topbar__actions">
        <IdentitySwitcher />
        <IconButton label="Command palette" hint="⌘K" onClick={() => setPalette(true)}>
          <Command size={15} />
        </IconButton>
        <IconButton
          label="Sync now"
          onClick={() => void refresh()}
          style={busy ? { animation: 'spin 900ms linear infinite' } : undefined}
        >
          <Refresh size={15} />
        </IconButton>
        <Button variant="primary" onClick={() => compose()}>
          <Plus size={14} />
          Compose
        </Button>
      </div>
    </header>
  );
}

/* ── Identity switcher ─────────────────────────────────────────────────────
   Who you are writing as, and a way to jump to that account's mail. Both live
   here because both answer the same question — "which of my twelve addresses
   am I dealing with right now" — and answering it twice in two places is how
   the two answers drift apart. */

function IdentitySwitcher() {
  const accounts = useStore((s) => s.accounts);
  const identityId = useStore((s) => s.identityId);
  const setIdentity = useStore((s) => s.setIdentity);
  const setScope = useStore((s) => s.setScope);
  const compose = useStore((s) => s.compose);
  const colorOf = useAccountColor();

  const current = accounts.find((a) => a.id === identityId) ?? accounts[0];
  if (!current) return null;

  const byDomain = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const list = byDomain.get(a.domain);
    if (list) list.push(a);
    else byDomain.set(a.domain, [a]);
  }

  return (
    <Popover
      align="end"
      width={340}
      trigger={(p) => (
        <button
          type="button"
          className="identity"
          title={`Writing as ${current.address}`}
          {...p}
        >
          <span
            className="identity__chip"
            style={{ '--tint': colorOf(current.id) } as React.CSSProperties}
          />
          <span className="identity__label truncate">{current.label}</span>
          <Chevron size={11} />
        </button>
      )}
    >
      {(close) => (
        <>
          <PopLabel>Writing as</PopLabel>
          {[...byDomain].map(([domain, list]) => (
            <div key={domain}>
              <div className="identity__domain">{domain}</div>
              {list.map((a) => (
                <div className="identity__row" key={a.id}>
                  <button
                    type="button"
                    className="pop__item"
                    role="menuitemradio"
                    aria-checked={a.id === current.id}
                    onClick={() => {
                      setIdentity(a.id);
                      close();
                    }}
                  >
                    <span
                      className="identity__chip"
                      style={{ '--tint': colorOf(a.id) } as React.CSSProperties}
                    />
                    <span className="truncate">{a.label}</span>
                    <span className="identity__addr truncate">{a.address}</span>
                    {a.id === current.id && (
                      <span className="pop__item__check">
                        <Check size={13} />
                      </span>
                    )}
                  </button>
                  <IconButton
                    label={`Go to ${a.label}`}
                    onClick={() => {
                      setScope({ kind: 'account', value: a.id, role: 'inbox' });
                      close();
                    }}
                  >
                    <Inbox size={14} />
                  </IconButton>
                  <IconButton
                    label={`Compose as ${a.address}`}
                    onClick={() => {
                      setIdentity(a.id);
                      compose({ accountId: a.id });
                      close();
                    }}
                  >
                    <Plus size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}

/* ── Toasts ───────────────────────────────────────────────────────────────── */

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.message}</span>
          {t.undo && (
            <button
              type="button"
              className="toast__undo"
              onClick={() => {
                t.undo!();
                dismiss(t.id);
              }}
            >
              <Undo size={13} />
              Undo
              <Kbd>z</Kbd>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
