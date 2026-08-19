/**
 * Second level of navigation. What it shows depends on the rail selection:
 *
 *   unified  → role folders across everything, then every account, collapsed
 *   domain   → that domain's accounts, expanded, with their folder trees
 *
 * Folder trees stay collapsed until asked for. Progressive disclosure is the
 * only thing that keeps a 12-account, 90-folder tree usable.
 *
 * Under `unified`, accounts sit in whatever groups the user has dragged them
 * into, and everything else falls through to the domain ordering. The domain is
 * a fact about the address; the group is what the mailbox is *for*, and with
 * forty-five of them across eight domains the second question is the one being
 * asked. Groups are preferences, not schema — see `AccountGroup` in types.ts.
 */

import { useRef, useState } from 'react';
import {
  Archive,
  Chevron,
  Draft,
  Folder as FolderIcon,
  Inbox,
  Junk,
  Plus,
  Send,
  Star,
  Trash,
  Warning,
} from '@/components/icons';
import { Button } from '@/components/ui';
import { count } from '@/lib/format';
import { useContextMenu } from '@/components/context-menu';
import { useDomains, useSidebarGroups, useStore, type ResolvedGroup } from '@/lib/store';
import { FolderMenu, type SidebarTarget } from './FolderMenu';
import type { Account, Folder, FolderRole, Id, Scope } from '@/lib/types';

const ROLE_ICON: Record<FolderRole, typeof Inbox> = {
  inbox: Inbox,
  drafts: Draft,
  sent: Send,
  archive: Archive,
  junk: Junk,
  trash: Trash,
  flagged: Star,
  all: FolderIcon,
  custom: FolderIcon,
};

const UNIFIED_ROLES: { role: FolderRole; label: string }[] = [
  { role: 'inbox', label: 'Inbox' },
  { role: 'drafts', label: 'Drafts' },
  { role: 'sent', label: 'Sent' },
  { role: 'archive', label: 'Archive' },
  { role: 'junk', label: 'Junk' },
  { role: 'trash', label: 'Trash' },
];

/** One controller for the whole tree, shared down through props. Mounting a
 *  menu per folder would mean one per node in a tree that can run to ninety. */
export function Sidebar() {
  const scope = useStore((s) => s.query.scope);
  const domains = useDomains();
  const accounts = useStore((s) => s.accounts);
  const setOnboarding = useStore((s) => s.setOnboarding);
  const createAccountGroup = useStore((s) => s.createAccountGroup);
  const moveAccountToGroup = useStore((s) => s.moveAccountToGroup);
  const menu = useContextMenu<SidebarTarget>();
  const { groups, ungrouped } = useSidebarGroups();

  /* One drag controller for the whole pane. The zones are found by hit-testing
     rather than by subscribing, so nothing below has to be told a drag is
     happening except to draw itself differently. */
  const drag = useAccountDrag((accountId, groupId) => void moveAccountToGroup(accountId, groupId));

  const domain = scope.kind === 'domain' ? scope.value : null;
  const inDomain = domain ? (domains.find((d) => d.domain === domain)?.accounts ?? []) : [];

  return (
    <aside className="sidebar" aria-label="Folders">
      <div className="sidebar__head">
        <div className="sidebar__title truncate">{domain ?? 'All mail'}</div>
        <div className="sidebar__sub">
          {domain
            ? `${inDomain.length} account${inDomain.length === 1 ? '' : 's'}`
            : `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${domains.length} domain${domains.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="sidebar__scroll scroll-y">
        {domain ? (
          <>
            {inDomain.map((a) => (
              <AccountNode
                key={a.id}
                account={a}
                defaultOpen={inDomain.length <= 2}
                onMenu={menu.onContextMenu}
              />
            ))}
          </>
        ) : (
          <>
            <section className="sidebar__section">
              {UNIFIED_ROLES.map(({ role, label }) => (
                <UnifiedRoleNav key={role} role={role} label={label} />
              ))}
            </section>

            <section className="sidebar__section">
              <div className="sidebar__sectionhead">
                <span className="label">Accounts</span>
                <button
                  type="button"
                  className="sidebar__addgroup"
                  title="New group"
                  onClick={() => void createAccountGroup(nextGroupName(groups.length))}
                >
                  <Plus size={11} />
                  Group
                </button>
              </div>

              {groups.map((g) => (
                <GroupNode key={g.group.id} resolved={g} drag={drag} onMenu={menu.onContextMenu} />
              ))}

              {/* Dropping outside every group is how a mailbox gets back out of
                  one. Without a target for it, a group would be a one-way door. */}
              <DropZone groupId={null} label="Drop here to ungroup" drag={drag}>
                {ungrouped.map(({ domain: d, accounts: list }) => (
                  <div key={d}>
                    {list.map((a) => (
                      <AccountNode
                        key={a.id}
                        account={a}
                        defaultOpen={false}
                        drag={drag}
                        onMenu={menu.onContextMenu}
                      />
                    ))}
                  </div>
                ))}
              </DropZone>
            </section>
          </>
        )}
      </div>

      <div className="sidebar__foot">
        <Button variant="outline" size="sm" block onClick={() => setOnboarding(true)}>
          <Plus size={13} />
          Add account
        </Button>
      </div>

      <FolderMenu controller={menu} />
      {drag.state && <DragGhost state={drag.state} />}
    </aside>
  );
}

/* ── Unified role row ─────────────────────────────────────────────────────── */

function UnifiedRoleNav({ role, label }: { role: FolderRole; label: string }) {
  const scope = useStore((s) => s.query.scope);
  const setScope = useStore((s) => s.setScope);
  const folders = useStore((s) => s.folders);
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);

  const visible = new Set(accounts.filter((a) => !a.hidden).map((a) => a.id));
  const matching = folders.filter((f) => f.role === role && visible.has(f.accountId));
  const unread = matching.reduce((n, f) => n + f.unread, 0);
  const Icon = ROLE_ICON[role];
  const active = scope.kind === 'unified' && scope.role === role;
  const tint = prefs?.theme.folderColors[role];

  return (
    <button
      type="button"
      className="nav"
      aria-current={active}
      data-unread={unread > 0 || undefined}
      style={tint ? ({ '--nav-tint': tint } as React.CSSProperties) : undefined}
      onClick={() => setScope({ kind: 'unified', value: null, role })}
    >
      <span className="nav__icon">
        <Icon size={15} />
      </span>
      <span className="nav__label">{label}</span>
      {/* Unread only. A count of everything in a folder answers a question
          nobody asked and puts a number next to Sent and Trash that never
          changes, which trains the eye to stop reading the column that is
          supposed to be carrying the one number that matters. */}
      <span className="nav__count tnum">{unread > 0 ? count(unread) : ''}</span>
    </button>
  );
}

/* ── Groups ───────────────────────────────────────────────────────────────── */

/**
 * Dragging a mailbox, on pointer events rather than HTML5 drag-and-drop.
 *
 * The native API was the obvious choice and it does not work here. A drag
 * source has to be the account row, the account row is a `<button>` because
 * every interactive thing in this app is a real button, and Chrome consumes
 * mousedown on a form control as activation — so `dragstart` never fires and
 * `draggable` is silently inert. Moving `draggable` to a wrapper does not help:
 * the gesture still begins on the button inside it.
 *
 * Pointer events have none of that. They also work on a touchscreen, behave the
 * same in every browser, need no `dataTransfer` round trip, and — not nothing —
 * can be driven by synthetic events, which means this is testable and the
 * native version was not.
 *
 * The 4px threshold is what keeps a click a click: below it nothing has been
 * dragged, and the row's own `onClick` runs untouched.
 */
const DRAG_THRESHOLD_PX = 4;

/** Marks the ungrouped region. An empty string rather than a sentinel word so
 *  it can live in `data-group-id` and read back as "no group". */
const UNGROUPED = '';

interface DragState {
  accountId: Id;
  label: string;
  x: number;
  y: number;
  /** The `data-group-id` under the pointer, or undefined over no zone at all. */
  over: string | undefined;
}

export interface AccountDrag {
  state: DragState | null;
  /** Attach to an account row. Does nothing until the pointer actually moves. */
  onPointerDown: (e: React.PointerEvent, account: Account) => void;
  /** True for the one click that is the tail of a drag, and must not navigate. */
  draggedJustNow: () => boolean;
}

/** Which drop zone, if any, is under a point. The ghost is `pointer-events:
 *  none` precisely so it cannot answer this question about itself. */
function zoneAt(x: number, y: number): string | undefined {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-dropzone]');
  return el?.dataset.groupId;
}

function useAccountDrag(onDrop: (accountId: Id, groupId: Id | null) => void): AccountDrag {
  const [state, setState] = useState<DragState | null>(null);
  const draggedRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent, account: Account) => {
    // Left button only. A right-click here is the context menu, which is the
    // keyboard-reachable path to the same move.
    if (e.button !== 0) return;
    const origin = { x: e.clientX, y: e.clientY };
    let live = false;

    const move = (ev: PointerEvent) => {
      if (!live) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
        live = true;
        draggedRef.current = true;
        document.body.dataset.dragging = 'account';
      }
      setState({
        accountId: account.id,
        label: account.label,
        x: ev.clientX,
        y: ev.clientY,
        over: zoneAt(ev.clientX, ev.clientY),
      });
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      delete document.body.dataset.dragging;
      setState(null);
      // Release the click guard on a timer rather than when a click arrives.
      //
      // A drag does not reliably end in a click — release outside the row, or
      // over a different element, and none is dispatched at all. Clearing the
      // flag only on the next click therefore left it stuck true, and the next
      // *ordinary* click on any mailbox was swallowed: the sidebar simply
      // stopped navigating. The browser fires click in the same task as
      // pointerup, so a zero-delay timer lands after it either way.
      if (live) setTimeout(() => (draggedRef.current = false), 0);
    };

    const up = (ev: PointerEvent) => {
      const wasLive = live;
      const target = wasLive ? zoneAt(ev.clientX, ev.clientY) : undefined;
      stop();
      // Dropped on nothing is a cancelled drag, not a move to the top level —
      // otherwise letting go over the message list would silently ungroup.
      if (wasLive && target !== undefined) {
        onDrop(account.id, target === UNGROUPED ? null : target);
      }
    };

    const cancel = () => stop();
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  };

  return { state, onPointerDown, draggedJustNow: () => draggedRef.current };
}

/** The row that follows the pointer. Without one there is no feedback between
 *  picking a mailbox up and putting it down, and the gesture reads as broken
 *  even when it works. */
function DragGhost({ state }: { state: DragState }) {
  return (
    <div className="dragghost" style={{ transform: `translate(${state.x + 12}px, ${state.y - 10}px)` }}>
      <FolderIcon size={12} />
      {state.label}
    </div>
  );
}

function nextGroupName(existing: number): string {
  return existing ? `Group ${existing + 1}` : 'New group';
}

/**
 * A region that accepts a dropped mailbox.
 *
 * Purely presentational: the controller finds it by hit-testing
 * `[data-dropzone]`, so this only has to announce which group it is and light
 * up when the pointer is over it.
 *
 * **Nothing here may change size when a drag starts.** The first version added
 * a "Move into Work" line inside each zone on `data-active`, which grew every
 * zone by a row the instant you picked a mailbox up — so the zone you were
 * aiming at slid 25px down before you got there and the drop landed in the one
 * above it. The zones are hit-tested by coordinate; a target that moves when
 * you reach for it is not a target. The outline, the fill and the hint are all
 * either always-present or out of flow for exactly this reason.
 */
function DropZone({
  groupId,
  label,
  drag,
  children,
}: {
  /** Null is the ungrouped region. */
  groupId: Id | null;
  label: string;
  drag: AccountDrag;
  children: React.ReactNode;
}) {
  const key = groupId ?? UNGROUPED;
  const active = drag.state !== null;
  const over = active && drag.state?.over === key;

  return (
    <div
      className="dropzone"
      data-dropzone=""
      data-group-id={key}
      data-active={active || undefined}
      data-over={over || undefined}
    >
      {children}
      {/* Absolutely positioned, so naming the target costs no height. */}
      {over && <div className="dropzone__hint">{label}</div>}
    </div>
  );
}

/**
 * One user-made group, and the mailboxes in it.
 *
 * Collapsed state is stored, not local: a group you closed because it is the
 * one you are ignoring this month should still be closed tomorrow, and it is
 * one boolean in a blob the client already reads whole.
 */
function GroupNode({
  resolved,
  drag,
  onMenu,
}: {
  resolved: ResolvedGroup;
  drag: AccountDrag;
  onMenu: (e: React.MouseEvent, target: SidebarTarget) => void;
}) {
  const toggleAccountGroup = useStore((s) => s.toggleAccountGroup);
  const { group, accounts, unread } = resolved;
  const open = !group.collapsed;

  return (
    <div className="group">
      <DropZone groupId={group.id} label={`Move into ${group.name}`} drag={drag}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            className="nav__twisty"
            data-open={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => void toggleAccountGroup(group.id)}
          >
            <Chevron size={12} />
          </button>
          <button
            type="button"
            className="nav nav--group"
            data-unread={unread > 0 || undefined}
            style={group.color ? ({ '--nav-tint': group.color } as React.CSSProperties) : undefined}
            onClick={() => void toggleAccountGroup(group.id)}
            onContextMenu={(e) => onMenu(e, { kind: 'group', group })}
            title={`${group.name} — right-click to rename, colour or remove`}
          >
            <span className="nav__icon">
              <FolderIcon size={13} />
            </span>
            <span className="nav__label">{group.name}</span>
            <span className="nav__count tnum">{unread > 0 ? count(unread) : ''}</span>
          </button>
        </div>

        {open && (
          <div className="subtree">
            {accounts.length ? (
              accounts.map((a) => (
                <AccountNode
                  key={a.id}
                  account={a}
                  defaultOpen={false}
                  drag={drag}
                  onMenu={onMenu}
                />
              ))
            ) : (
              <div className="group__empty">Drag a mailbox here</div>
            )}
          </div>
        )}
      </DropZone>
    </div>
  );
}

/* ── Account node ─────────────────────────────────────────────────────────── */

function AccountNode({
  account,
  defaultOpen,
  drag,
  onMenu,
}: {
  account: Account;
  defaultOpen: boolean;
  /** Absent inside a domain view, where there are no groups to drag into. */
  drag?: AccountDrag;
  onMenu: (e: React.MouseEvent, target: SidebarTarget) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Select the raw array and narrow it here — a selector that returns a fresh
  // array on every call makes zustand's snapshot comparison always fail.
  const allFolders = useStore((s) => s.folders);
  const folders = allFolders.filter((f) => f.accountId === account.id);
  const scope = useStore((s) => s.query.scope);
  const setScope = useStore((s) => s.setScope);
  const prefs = useStore((s) => s.prefs);
  const setSettings = useStore((s) => s.setSettings);

  const tint = account.color ?? prefs?.theme.domainColors[account.domain] ?? 'var(--line-strong)';
  const active = scope.kind === 'account' && scope.value === account.id;
  const broken = account.status === 'auth_error' || account.status === 'connect_error';

  const roots = folders.filter((f) => !f.parentId).sort((a, b) => a.position - b.position);

  return (
    <div data-dragging={drag?.state?.accountId === account.id || undefined}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button
          type="button"
          className="nav__twisty"
          data-open={open}
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen((v) => !v)}
        >
          <Chevron size={12} />
        </button>
        <button
          type="button"
          className="nav nav--account"
          style={{ '--tint': tint } as React.CSSProperties}
          aria-current={active}
          data-unread={account.unread > 0 || undefined}
          onPointerDown={drag && ((e) => drag.onPointerDown(e, account))}
          onClick={() => {
            // The click that closes a drag must not also navigate. Below the
            // threshold nothing was dragged and this is false, so an ordinary
            // click is untouched.
            if (drag?.draggedJustNow()) return;
            setScope({ kind: 'account', value: account.id, role: 'inbox' });
          }}
          onContextMenu={(e) =>
            onMenu(e, { kind: 'account', accountId: account.id, label: account.label })
          }
          title={account.address}
        >
          <span className="nav__label">{account.label}</span>
          {broken ? (
            <span style={{ color: 'var(--danger)', display: 'grid' }}>
              <Warning size={13} />
            </span>
          ) : (
            <span className="nav__count tnum">{account.unread > 0 ? count(account.unread) : ''}</span>
          )}
        </button>
      </div>

      {broken && (
        <button type="button" className="problem" onClick={() => setSettings(`account:${account.id}`)}>
          <Warning size={13} />
          <span>
            {account.status === 'auth_error' ? 'Sign-in failed' : 'Cannot reach server'} — fix credentials
          </span>
        </button>
      )}

      {open && (
        <div className="subtree">
          {roots.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              allFolders={folders}
              scope={scope}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Folder node ──────────────────────────────────────────────────────────── */

function FolderNode({
  folder,
  allFolders,
  scope,
  onMenu,
}: {
  folder: Folder;
  allFolders: Folder[];
  scope: Scope;
  onMenu: (e: React.MouseEvent, target: SidebarTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const setScope = useStore((s) => s.setScope);
  const prefs = useStore((s) => s.prefs);
  const children = allFolders.filter((f) => f.parentId === folder.id);
  const Icon = ROLE_ICON[folder.role];
  const active = scope.kind === 'folder' && scope.value === folder.id;
  const tint = folder.color ?? prefs?.theme.folderColors[folder.role];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {children.length > 0 ? (
          <button
            type="button"
            className="nav__twisty"
            data-open={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen((v) => !v)}
            style={{ marginLeft: folder.depth * 12 }}
          >
            <Chevron size={12} />
          </button>
        ) : (
          <span style={{ width: 14, marginLeft: folder.depth * 12, flexShrink: 0 }} />
        )}
        <button
          type="button"
          className="nav nav--child"
          style={
            {
              '--depth': folder.depth,
              ...(tint ? { '--nav-tint': tint } : {}),
            } as React.CSSProperties
          }
          aria-current={active}
          data-unread={folder.unread > 0 || undefined}
          onClick={() => setScope({ kind: 'folder', value: folder.id, role: null })}
          onContextMenu={(e) => onMenu(e, { kind: 'folder', folder })}
        >
          <span className="nav__icon">
            <Icon size={13} />
          </span>
          <span className="nav__label">{folder.name}</span>
          <span className="nav__count tnum">{folder.unread > 0 ? count(folder.unread) : ''}</span>
        </button>
      </div>

      {open && (
        <div className="subtree">
          {children.map((c) => (
            <FolderNode
              key={c.id}
              folder={c}
              allFolders={allFolders}
              scope={scope}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
