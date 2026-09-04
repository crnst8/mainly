/**
 * The right-click menu for the sidebar.
 *
 * One menu serves folders and accounts, because what you want from them is
 * nearly the same list — open it, make a folder in it, colour it — and splitting
 * that into two menus would mean two places to keep in step.
 *
 * Creating happens here rather than behind a modal. A folder is a small thing
 * and the name is the only decision; a dialog for it would be three interactions
 * where one will do, and you would lose the place in the tree you right-clicked
 * to get to.
 */

import { useState } from 'react';
import { Check, Dot, Folder as FolderIcon, Inbox, Plus, Refresh, Trash } from '@/components/icons';
import {
  ContextMenu,
  MenuItem,
  MenuSub,
  MenuToggle,
  type ContextMenuController,
} from '@/components/context-menu';
import { PopLabel, PopSep } from '@/components/ui';
import { useSidebarGroups, useStore } from '@/lib/store';
import { groupTintsMembers } from '@/lib/types';
import type { AccountGroup, Folder } from '@/lib/types';

/** What was right-clicked. A folder carries its account so "new folder here"
 *  knows where to put it without walking the tree again. */
export type SidebarTarget =
  | { kind: 'folder'; folder: Folder }
  | { kind: 'account'; accountId: string; label: string }
  | { kind: 'group'; group: AccountGroup };

const FOLDER_COLORS = [
  'oklch(64% 0.16 258)',
  'oklch(64% 0.16 292)',
  'oklch(66% 0.16 28)',
  'oklch(64% 0.14 168)',
  'oklch(68% 0.16 88)',
  'oklch(64% 0.17 338)',
  'oklch(64% 0.16 218)',
  'oklch(62% 0.14 128)',
];

export function FolderMenu({ controller }: { controller: ContextMenuController<SidebarTarget> }) {
  return (
    <ContextMenu controller={controller} width={228}>
      {(target, close) => <Body target={target} close={close} />}
    </ContextMenu>
  );
}

function Body({ target, close }: { target: SidebarTarget; close: () => void }) {
  const setScope = useStore((s) => s.setScope);
  const updateFolder = useStore((s) => s.updateFolder);
  const triggerSync = useStore((s) => s.triggerSync);

  // A group is a different kind of thing entirely — it holds mailboxes, not
  // mail — so it gets its own menu rather than a set of disabled items in this
  // one.
  if (target.kind === 'group') return <GroupBody group={target.group} close={close} />;

  const accountId = target.kind === 'folder' ? target.folder.accountId : target.accountId;
  const folder = target.kind === 'folder' ? target.folder : null;

  const run = (fn: () => void) => {
    fn();
    close();
  };

  return (
    <>
      <PopLabel>{target.kind === 'folder' ? target.folder.name : target.label}</PopLabel>

      <MenuItem
        icon={folder ? <FolderIcon size={13} /> : <Inbox size={13} />}
        onClick={() =>
          run(() =>
            setScope(
              folder
                ? { kind: 'folder', value: folder.id, role: null }
                : { kind: 'account', value: accountId, role: null },
            ),
          )
        }
      >
        Open
      </MenuItem>

      <MenuItem
        icon={<Refresh size={13} />}
        onClick={() => run(() => void triggerSync(accountId))}
      >
        Sync now
      </MenuItem>

      <MarkRead
        accountIds={[accountId]}
        folderIds={folder ? [folder.id] : undefined}
        unread={folder ? folder.unread : undefined}
        label={target.kind === 'folder' ? target.folder.name : target.label}
        close={close}
      />

      <PopSep />

      <NewFolder
        accountId={accountId}
        parent={folder}
        onDone={close}
      />

      {folder && (
        <MenuSub label="Colour" icon={<FolderIcon size={13} />} width={200}>
          <PopLabel>Folder colour</PopLabel>
          <div className="pop__swatches">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                aria-label={c}
                aria-pressed={folder.color === c}
                style={{ '--tint': c } as React.CSSProperties}
                onClick={() => run(() => void updateFolder(folder.id, { color: c }))}
              />
            ))}
          </div>
          <PopSep />
          <MenuItem onClick={() => run(() => void updateFolder(folder.id, { color: null }))}>
            No colour
          </MenuItem>
        </MenuSub>
      )}

      {folder && (
        <MenuItem
          icon={folder.pinned ? <Check size={13} /> : <Plus size={12} />}
          onClick={() => run(() => void updateFolder(folder.id, { pinned: !folder.pinned }))}
        >
          {folder.pinned ? 'Unpin' : 'Pin to top'}
        </MenuItem>
      )}

      {/* Drag is the fast path, not the only one. A pointer gesture that is the
          sole way to reach a feature is a feature keyboard and screen-reader
          users do not have. */}
      {target.kind === 'account' && <MoveToGroup accountId={accountId} onDone={close} />}
    </>
  );
}

/* ── Group menu ───────────────────────────────────────────────────────────── */

function GroupBody({ group: opened, close }: { group: AccountGroup; close: () => void }) {
  const renameAccountGroup = useStore((s) => s.renameAccountGroup);
  const setAccountGroupColor = useStore((s) => s.setAccountGroupColor);
  const toggleAccountGroupTint = useStore((s) => s.toggleAccountGroupTint);
  const removeAccountGroup = useStore((s) => s.removeAccountGroup);
  const { groups } = useSidebarGroups();
  const [name, setName] = useState(opened.name);

  /* The resolved membership, not `group.accountIds`: a group can name a mailbox
     that has since been removed, and acting on an id nothing resolves is how a
     bulk action reports a count that does not match what happened. */
  const resolved = groups.find((g) => g.group.id === opened.id);
  const accountIds = (resolved?.accounts ?? []).map((a) => a.id);

  /* The live record, not the snapshot the right-click captured. The menu stays
     open across a toggle — that is the point of a checkbox rather than a
     command — so anything drawing a tick has to read state that changes under
     it. Falls back to the snapshot only while the group is being removed. */
  const group = resolved?.group ?? opened;
  const tintsMembers = groupTintsMembers(group);

  return (
    <>
      <PopLabel>{group.name}</PopLabel>

      <div className="pop__field">
        <input
          className="input"
          autoFocus
          aria-label="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void renameAccountGroup(group.id, name);
              close();
            }
            if (e.key === 'Escape') e.stopPropagation();
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
          }}
        />
      </div>

      <MenuSub label="Colour" icon={<FolderIcon size={13} />} width={216}>
        <PopLabel>Group colour</PopLabel>
        <div className="pop__swatches">
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              aria-label={c}
              aria-pressed={group.color === c}
              style={{ '--tint': c } as React.CSSProperties}
              onClick={() => {
                void setAccountGroupColor(group.id, c);
                close();
              }}
            />
          ))}
        </div>
        <PopSep />
        <MenuItem
          onClick={() => {
            void setAccountGroupColor(group.id, null);
            close();
          }}
        >
          No colour
        </MenuItem>
        <PopSep />
        {/* Lives here rather than in the group menu proper: it modifies the
            swatch above it, and it is on by default, so it belongs where you
            can see what it did. Does not close the menu — the whole value of a
            checkbox is watching the sidebar change while it is still open. */}
        <MenuToggle
          checked={tintsMembers}
          icon={<FolderIcon size={13} />}
          onClick={() => void toggleAccountGroupTint(group.id)}
        >
          Colour mailboxes too
        </MenuToggle>
      </MenuSub>

      <PopSep />

      <MarkRead accountIds={accountIds} label={group.name} text="Mark all in group read" close={close} />

      <PopSep />

      {/* No confirmation: the mailboxes are untouched and the group is one line
          in a preferences blob. Making this reversible would cost more than
          making it again. */}
      <MenuItem
        icon={<Trash size={13} />}
        onClick={() => {
          void removeAccountGroup(group.id);
          close();
        }}
      >
        Remove group
      </MenuItem>
    </>
  );
}

/**
 * Mark everything unread in these mailboxes as read.
 *
 * Two states, because this is the one item here that reaches across mail the
 * sidebar is not showing: it says how many are unread before you commit, and it
 * disables itself at zero rather than offering an action that would do nothing.
 * The work itself is undoable — see `markAccountsRead`.
 */
function MarkRead({
  accountIds,
  folderIds,
  unread,
  label,
  text = 'Mark all read',
  close,
}: {
  accountIds: string[];
  /** Narrows the sweep to one folder. Absent means the whole mailbox. */
  folderIds?: string[];
  /** Overrides the summed account count when the target is narrower. */
  unread?: number;
  /** What the target is called, for the toast. */
  label: string;
  text?: string;
  close: () => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const markAccountsRead = useStore((s) => s.markAccountsRead);
  const count =
    unread ??
    accounts.filter((a) => accountIds.includes(a.id)).reduce((n, a) => n + a.unread, 0);

  return (
    <MenuItem
      icon={<Dot size={9} />}
      hint={count > 0 ? String(count) : undefined}
      disabled={count === 0 || accountIds.length === 0}
      onClick={() => {
        void markAccountsRead(accountIds, label, folderIds);
        close();
      }}
    >
      {text}
    </MenuItem>
  );
}

/** Where an account can be filed, without a pointer. */
function MoveToGroup({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const groups = useStore((s) => s.prefs?.accountGroups);
  const moveAccountToGroup = useStore((s) => s.moveAccountToGroup);
  const createAccountGroup = useStore((s) => s.createAccountGroup);

  const list = [...(groups ?? [])].sort((a, b) => a.position - b.position);
  const current = list.find((g) => g.accountIds.includes(accountId));

  return (
    <MenuSub label="Move to group" icon={<FolderIcon size={13} />} width={220}>
      <PopLabel>Groups</PopLabel>
      {list.map((g) => (
        <MenuItem
          key={g.id}
          icon={current?.id === g.id ? <Check size={13} /> : undefined}
          onClick={() => {
            void moveAccountToGroup(accountId, g.id);
            onDone();
          }}
        >
          {g.name}
        </MenuItem>
      ))}
      {current && (
        <MenuItem
          onClick={() => {
            void moveAccountToGroup(accountId, null);
            onDone();
          }}
        >
          No group
        </MenuItem>
      )}
      <PopSep />
      <MenuItem
        icon={<Plus size={12} />}
        onClick={() => {
          void createAccountGroup(`Group ${list.length + 1}`).then((id) => {
            if (id) void moveAccountToGroup(accountId, id);
          });
          onDone();
        }}
      >
        New group…
      </MenuItem>
    </MenuSub>
  );
}

/**
 * The inline "new folder" affordance.
 *
 * Nested under whatever was right-clicked: a folder makes a subfolder, an
 * account makes a top-level folder. That is the whole reason the menu carries
 * its target — "new folder" with no sense of *where* is the thing that makes
 * people give up and use the webmail their host ships.
 */
function NewFolder({
  accountId,
  parent,
  onDone,
}: {
  accountId: string;
  parent: Folder | null;
  onDone: () => void;
}) {
  const createFolder = useStore((s) => s.createFolder);
  const setScope = useStore((s) => s.setScope);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const folder = await createFolder(accountId, trimmed, parent?.id ?? null);
    setBusy(false);
    if (!folder) return;
    // Go to what you just made. Creating a folder and being left where you were
    // makes it feel like nothing happened.
    setScope({ kind: 'folder', value: folder.id, role: null });
    onDone();
  }

  if (!open) {
    return (
      <MenuItem icon={<Plus size={12} />} onClick={() => setOpen(true)}>
        {parent ? 'New subfolder…' : 'New folder…'}
      </MenuItem>
    );
  }

  return (
    <div className="pop__field">
      <input
        className="input"
        autoFocus
        disabled={busy}
        placeholder={parent ? `Inside ${parent.name}` : 'Folder name'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
        }}
      />
    </div>
  );
}
