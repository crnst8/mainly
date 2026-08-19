/**
 * The right-click menu for message rows.
 *
 * Two things govern its shape.
 *
 * **It acts on the selection.** Right-clicking a row that is part of a
 * multi-selection acts on all of it; right-clicking outside the selection acts
 * on that row alone and takes the selection with it. This is what every file
 * manager does, and getting it wrong — silently acting on one row when twelve
 * are highlighted — is the kind of mistake that loses mail.
 *
 * **Labels are the reason it exists.** The contract has carried a `label` action
 * and a `labelColors` map since the beginning, and until now nothing in the
 * interface could apply one: labels rendered as coloured chips that could never
 * be created. A right-click is where a labelling affordance belongs, because it
 * is per-message and too specific to earn a place in the toolbar.
 */

import { useMemo, useState } from 'react';
import {
  Archive,
  Clock,
  Dot,
  Folder as FolderIcon,
  Palette as PaletteIcon,
  Plus,
  Reply,
  Star,
  Trash,
} from '@/components/icons';
import { ContextMenu, MenuItem, MenuSub, MenuToggle, type ContextMenuController } from '@/components/context-menu';
import { PopLabel, PopSep } from '@/components/ui';
import { getApi } from '@/lib/api';
import { emptyFilters } from '@/lib/query';
import { useStore } from '@/lib/store';
import type { Folder, ListQuery, MessageSummary } from '@/lib/types';

/** Enough hues to tell a dozen labels apart, drawn from the same family the
 *  domain palette uses so a labelled row and a domain stripe never clash. */
const LABEL_COLORS = [
  'oklch(64% 0.16 258)',
  'oklch(64% 0.16 292)',
  'oklch(66% 0.16 28)',
  'oklch(64% 0.14 168)',
  'oklch(68% 0.16 88)',
  'oklch(64% 0.17 338)',
  'oklch(64% 0.16 218)',
  'oklch(62% 0.14 128)',
];

export function MessageMenu({ controller }: { controller: ContextMenuController<MessageSummary> }) {
  return (
    <ContextMenu controller={controller} width={236}>
      {(message, close) => <Body message={message} close={close} />}
    </ContextMenu>
  );
}

function Body({ message, close }: { message: MessageSummary; close: () => void }) {
  const selectedIds = useStore((s) => s.selectedIds);
  const folders = useStore((s) => s.folders);
  const prefs = useStore((s) => s.prefs);
  const result = useStore((s) => s.result);

  const setRead = useStore((s) => s.setRead);
  const setFlag = useStore((s) => s.setFlag);
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);
  const setLabels = useStore((s) => s.setLabels);
  const moveTo = useStore((s) => s.moveTo);
  const act = useStore((s) => s.act);
  const reply = useStore((s) => s.reply);
  const open = useStore((s) => s.open);

  /* The set this menu acts on. See the note at the top of the file. */
  const ids = selectedIds.has(message.id) ? [...selectedIds] : [message.id];
  const many = ids.length > 1;
  const suffix = many ? ` ${ids.length}` : '';

  /*
   * What the read and star items will do, decided by the whole set rather than
   * by the row under the cursor.
   *
   * Reading the clicked row alone is how the menu came to contradict itself:
   * right-clicking a starred message inside a selection of twelve offered
   * "Remove star 12" and then starred all twelve, because the row said one thing
   * and the bulk toggle underneath decided another. Mixed goes *in* to the
   * state, and the label says so.
   */
  const rows = (result?.messages ?? []).filter((m) => ids.includes(m.id));
  const willRead = rows.length ? rows.some((m) => !m.seen) : !message.seen;
  const willFlag = rows.length ? rows.some((m) => !m.flagged) : !message.flagged;

  /**
   * Every label this user has, not merely the ones in view.
   *
   * Facets only count what is in the current scope, so a label applied last
   * month in another folder would vanish from the menu — and re-typing it is how
   * you end up with "Receipts" and "receipts". The colour map is the durable
   * record, so the union of the two is the real set.
   */
  const labels = useMemo(() => {
    const known = new Set<string>(Object.keys(prefs?.theme.labelColors ?? {}));
    for (const l of Object.keys(result?.facets.labels ?? {})) known.add(l);
    for (const l of message.labels) known.add(l);
    return [...known].sort((a, b) => a.localeCompare(b));
  }, [prefs?.theme.labelColors, result?.facets.labels, message.labels]);

  const run = (fn: () => void) => {
    fn();
    close();
  };

  return (
    <>
      <MenuItem icon={<Reply size={13} />} hint="↵" onClick={() => run(() => void open(message.id))}>
        Open
      </MenuItem>
      <MenuItem
        icon={<Reply size={13} />}
        hint="r"
        disabled={many}
        onClick={() =>
          run(() => {
            void open(message.id).then(() => reply(false));
          })
        }
      >
        Reply
      </MenuItem>

      <PopSep />

      <MenuItem
        icon={<Dot size={9} />}
        hint="u"
        onClick={() => run(() => void setRead(ids, willRead))}
      >
        {willRead ? `Mark read${suffix}` : `Mark unread${suffix}`}
      </MenuItem>
      <MenuItem
        icon={<Star size={13} filled={!willFlag} />}
        hint="s"
        onClick={() => run(() => void setFlag(ids, willFlag))}
      >
        {willFlag ? `Star${suffix}` : `Remove star${suffix}`}
      </MenuItem>

      <MenuSub label={`Label${suffix}`} icon={<PaletteIcon size={13} />} width={320}>
        <LabelPanel
          labels={labels}
          message={message}
          ids={ids}
          onDone={close}
          onToggle={(name, on) => void setLabels(ids, on ? [name] : [], on ? [] : [name])}
        />
      </MenuSub>

      <MenuSub label={`Move to${suffix}`} icon={<FolderIcon size={13} />} width={264}>
        <MovePanel
          folders={folders}
          message={message}
          onPick={(f) => run(() => void moveTo(ids, f.id, f.name))}
        />
      </MenuSub>

      <MenuItem
        icon={<Clock size={13} />}
        hint="z"
        onClick={() =>
          run(() =>
            void act(
              ids,
              { type: 'snooze', until: new Date(Date.now() + 86_400_000).toISOString() },
              'Snoozed until tomorrow',
            ),
          )
        }
      >
        Snooze a day{suffix}
      </MenuItem>

      <PopSep />

      <MenuItem icon={<Archive size={13} />} hint="e" onClick={() => run(() => void archive(ids))}>
        Archive{suffix}
      </MenuItem>
      <MenuItem danger icon={<Trash size={13} />} hint="#" onClick={() => run(() => void trash(ids))}>
        Move to trash{suffix}
      </MenuItem>
    </>
  );
}

/* ── Labels ───────────────────────────────────────────────────────────────── */

function LabelPanel({
  labels,
  message,
  ids,
  onToggle,
  onDone,
}: {
  labels: string[];
  message: MessageSummary;
  ids: string[];
  onToggle: (name: string, on: boolean) => void;
  onDone: () => void;
}) {
  const prefs = useStore((s) => s.prefs);
  const setLabels = useStore((s) => s.setLabels);
  const setLabelColor = useStore((s) => s.setLabelColor);
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestedLabel, setSuggestedLabel] = useState<string | null>(null);
  const [appliedLabels, setAppliedLabels] = useState(() => new Set(message.labels));

  const colors = prefs?.theme.labelColors ?? {};

  async function create(target: 'selection' | 'sender' | 'subject' = 'selection') {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);

    try {
      // A new label gets a colour immediately. A label with no colour renders as a
      // grey chip indistinguishable from every other grey chip, which defeats the
      // only reason to have them.
      if (!colors[name]) {
        await setLabelColor(name, LABEL_COLORS[Object.keys(colors).length % LABEL_COLORS.length]!);
      }

      if (target === 'selection') {
        await setLabels(ids, [name], []);
      } else {
        const count = await labelRelated(message, target, name, setLabels);
        toast(`Labelled ${count} message${count === 1 ? '' : 's'} · ${name}`);
      }

      setDraft('');
      onDone();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not apply that label');
    } finally {
      setBusy(false);
    }
  }

  const sender = message.from.name?.trim() || message.from.address;
  const subject = message.subject.trim();

  async function applyRelated(name: string, target: 'sender' | 'subject') {
    if (busy) return;
    setBusy(true);
    try {
      const count = await labelRelated(message, target, name, setLabels);
      toast(`Labelled ${count} message${count === 1 ? '' : 's'} · ${name}`);
      onDone();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not apply that label');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PopLabel>Labels</PopLabel>
      {labels.length === 0 && (
        <div className="pop__empty">
          No labels yet. Type a name below to make one — labels are yours, stored
          here rather than on the mail server.
        </div>
      )}
      {labels.map((name) => (
        <MenuToggle
          key={name}
          checked={appliedLabels.has(name)}
          swatch={colors[name] ?? null}
          onClick={() => {
            const adding = !appliedLabels.has(name);
            setAppliedLabels((current) => {
              const next = new Set(current);
              if (adding) next.add(name);
              else next.delete(name);
              return next;
            });
            onToggle(name, adding);
            setSuggestedLabel(adding ? name : null);
          }}
        >
          {name}
        </MenuToggle>
      ))}

      <PopSep />
      <div className="pop__field">
        <input
          className="input"
          placeholder="New label"
          value={draft}
          autoFocus
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value);
            setSuggestedLabel(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create('selection');
            }
            // Arrow keys belong to the input here, not to the menu's roving focus.
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
          }}
        />
      </div>

      {draft.trim() && (
        <>
          <PopSep />
          <PopLabel>Apply new label to</PopLabel>
          <MenuItem disabled={busy} hint="↵" onClick={() => void create('selection')}>
            {ids.length === 1 ? 'This message' : `${ids.length} selected messages`}
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => void create('sender')}>
            Every message from {sender}
          </MenuItem>
          {subject && (
            <MenuItem disabled={busy} onClick={() => void create('subject')}>
              Every message with “{subject}”
            </MenuItem>
          )}
        </>
      )}

      {!draft.trim() && suggestedLabel && (
        <>
          <PopSep />
          <PopLabel>Also apply “{suggestedLabel}” to</PopLabel>
          <MenuItem disabled={busy} onClick={() => void applyRelated(suggestedLabel, 'sender')}>
            Every message from {sender}
          </MenuItem>
          {subject && (
            <MenuItem disabled={busy} onClick={() => void applyRelated(suggestedLabel, 'subject')}>
              Every message with “{subject}”
            </MenuItem>
          )}
        </>
      )}
    </>
  );
}

/**
 * Find related messages through the ordinary read API, then label each page.
 * Exact checks after search matter: search is deliberately forgiving and
 * substring-based, while a bulk label must never spill onto a near-match.
 */
async function labelRelated(
  message: MessageSummary,
  target: 'sender' | 'subject',
  label: string,
  setLabels: (ids: string[], add: string[], remove: string[]) => Promise<void>,
): Promise<number> {
  const raw = target === 'sender'
    ? `from:"${message.from.address}"`
    : `subject:"${message.subject.replaceAll('"', ' ')}"`;
  const base: ListQuery = {
    scope: { kind: 'search', value: raw, role: null },
    sort: 'date',
    dir: 'desc',
    group: 'none',
    filters: emptyFilters(),
    threaded: false,
    limit: 500,
    cursor: null,
  };
  const api = await getApi();
  let cursor: string | null = null;
  let count = 0;

  do {
    const page = await api.list({ ...base, cursor });
    const matches = page.messages.filter((candidate) =>
      target === 'sender'
        ? candidate.from.address.toLowerCase() === message.from.address.toLowerCase()
        : candidate.subject === message.subject,
    );
    if (matches.length) {
      await setLabels(matches.map((candidate) => candidate.id), [label], []);
      count += matches.length;
    }
    cursor = page.nextCursor;
  } while (cursor);

  return count;
}

/* ── Move ─────────────────────────────────────────────────────────────────── */

function MovePanel({
  folders,
  message,
  onPick,
}: {
  folders: Folder[];
  message: MessageSummary;
  onPick: (f: Folder) => void;
}) {
  const createFolder = useStore((s) => s.createFolder);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  /* Only this message's own account. A move is an IMAP operation within one
     mailbox; there is no such thing as moving mail into another account's
     folder, and offering it would be a promise we cannot keep. */
  const mine = folders
    .filter((f) => f.accountId === message.accountId && f.id !== message.folderId)
    .sort((a, b) => a.position - b.position || a.path.localeCompare(b.path));

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const folder = await createFolder(message.accountId, trimmed, null);
    setBusy(false);
    // Making a folder from inside a move menu means you intended to move into
    // it; `onPick` is the parent's move-and-close.
    if (folder) onPick(folder);
  }

  return (
    <>
      <PopLabel>Move to</PopLabel>
      {mine.map((f) => (
        <MenuItem
          key={f.id}
          icon={<FolderIcon size={13} />}
          hint={f.unread > 0 ? String(f.unread) : undefined}
          onClick={() => onPick(f)}
        >
          {/* Nesting shown by indent rather than by printing the raw IMAP path,
              which on Maildir is "INBOX.Work.Clients" and reads as noise. */}
          <span style={{ paddingLeft: f.depth * 10 }}>{f.name}</span>
        </MenuItem>
      ))}

      <PopSep />
      {creating ? (
        <div className="pop__field">
          <input
            className="input"
            placeholder="Folder name"
            autoFocus
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setCreating(false);
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
            }}
          />
        </div>
      ) : (
        <MenuItem icon={<Plus size={12} />} onClick={() => setCreating(true)}>
          New folder…
        </MenuItem>
      )}
    </>
  );
}
