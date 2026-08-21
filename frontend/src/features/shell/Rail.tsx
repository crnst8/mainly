/**
 * The rail is the top level of navigation: one target per domain, plus the
 * unified view and saved views.
 *
 * With a dozen addresses across seven domains, a flat folder list is unusable —
 * this collapses the whole account set into an edge-anchored strip of fixed
 * targets (Fitts: edge targets are the fastest thing on screen) and defers
 * everything below domain level to the sidebar.
 */

import { Inbox, Key, Plus, Settings as SettingsIcon, SignOut, Star, User } from '@/components/icons';
import { IconButton, PopLabel, PopSep, Popover } from '@/components/ui';
import { useDomains, useStore } from '@/lib/store';

export function Rail() {
  const domains = useDomains();
  const views = useStore((s) => s.views);
  const scope = useStore((s) => s.query.scope);
  const prefs = useStore((s) => s.prefs);
  const setScope = useStore((s) => s.setScope);
  const openView = useStore((s) => s.openView);
  const setSettings = useStore((s) => s.setSettings);
  const setOnboarding = useStore((s) => s.setOnboarding);
  const accounts = useStore((s) => s.accounts);

  const totalUnread = accounts.reduce((n, a) => n + (a.hidden ? 0 : a.unread), 0);
  const tint = (domain: string) => prefs?.theme.domainColors[domain] ?? 'var(--n-6)';

  /** Two-letter glyph from the domain: "bigchungus.holdings" → BI, "notchungus.xyz" → NO. */
  const glyphOf = (domain: string) => {
    const [head = ''] = domain.split('.');
    return head.slice(0, 2);
  };

  return (
    <nav className="rail" aria-label="Domains">
      <div className="rail__group">
        <button
          type="button"
          className="rail__item"
          aria-current={scope.kind === 'unified'}
          aria-label={`All mail — ${totalUnread} unread`}
          title="All mail"
          onClick={() => setScope({ kind: 'unified', value: null, role: 'inbox' })}
        >
          <Inbox size={17} />
          {totalUnread > 0 && <span className="rail__badge" />}
        </button>
      </div>

      <div className="rail__sep" />

      <div className="rail__group">
        {domains.map(({ domain, accounts: list, unread }) => {
          const broken = list.some((a) => a.status === 'auth_error' || a.status === 'connect_error');
          return (
            <button
              key={domain}
              type="button"
              className="rail__item"
              style={{ '--tint': tint(domain), '--marker': tint(domain) } as React.CSSProperties}
              aria-current={scope.kind === 'domain' && scope.value === domain}
              aria-label={`${domain} — ${unread} unread`}
              title={`${domain} · ${list.length} account${list.length > 1 ? 's' : ''} · ${unread} unread`}
              onClick={() => setScope({ kind: 'domain', value: domain, role: 'inbox' })}
            >
              <span className="rail__glyph">{glyphOf(domain)}</span>
              {(unread > 0 || broken) && <span className="rail__badge" data-error={broken || undefined} />}
            </button>
          );
        })}
      </div>

      {views.some((v) => v.pinned) && (
        <>
          <div className="rail__sep" />
          <div className="rail__group">
            {views
              .filter((v) => v.pinned)
              .map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="rail__item"
                  aria-current={scope.kind === 'saved' && scope.value === v.id}
                  aria-label={v.name}
                  title={v.name}
                  onClick={() => openView(v.id)}
                >
                  {v.glyph === '★' ? (
                    <Star size={16} filled={scope.value === v.id} />
                  ) : (
                    <span className="rail__glyph" style={{ '--tint': v.color ?? 'var(--n-6)' } as React.CSSProperties}>
                      {v.glyph}
                    </span>
                  )}
                </button>
              ))}
          </div>
        </>
      )}

      <div className="rail__spacer" />

      <div className="rail__group">
        <IconButton label="Add account" onClick={() => setOnboarding(true)}>
          <Plus size={16} />
        </IconButton>
        <IconButton label="Settings" hint="," onClick={() => setSettings('appearance')}>
          <SettingsIcon size={16} />
        </IconButton>
        <AccountMenu />
      </div>
    </nav>
  );
}

/* ── Account menu ──────────────────────────────────────────────────────────
   Who you are signed in as, and the two things you can do about it.

   In the rail rather than the topbar, one step below Settings, because the
   topbar's right edge already carries an identity control — the one that picks
   which of your addresses a new message goes out as. Two chips a thumb apart,
   both showing an email address and meaning entirely different things, is how
   someone clicks "sign out" looking for "reply from another address".

   The rail is the app's own strip: All mail, your domains, Add account,
   Settings. "Which person is using this browser" belongs with those, and it is
   an edge target, which is the fastest thing on the screen to hit. */

function AccountMenu() {
  const user = useStore((s) => s.user);
  const setSettings = useStore((s) => s.setSettings);
  const signOut = useStore((s) => s.signOut);

  return (
    <Popover
      align="start"
      width={240}
      trigger={(p) => (
        <button
          type="button"
          className="rail__item rail__item--account"
          aria-label={user ? `Account — signed in as ${user.email}` : 'Account'}
          title={user ? `Signed in as ${user.email}` : 'Account'}
          {...p}
        >
          <User size={16} />
        </button>
      )}
    >
      {(close) => (
        <>
          <PopLabel>Signed in as</PopLabel>
          <div className="rail__account">{user?.email ?? '—'}</div>
          <PopSep />
          <button
            type="button"
            className="pop__item"
            role="menuitem"
            onClick={() => {
              setSettings('signin');
              close();
            }}
          >
            <Key size={14} />
            <span>Change password</span>
          </button>
          <button
            type="button"
            className="pop__item"
            role="menuitem"
            data-danger
            onClick={() => {
              close();
              void signOut();
            }}
          >
            <SignOut size={14} />
            <span>Sign out</span>
          </button>
        </>
      )}
    </Popover>
  );
}
