import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Attachment as AttachIcon,
  Chevron,
  Clock,
  Eye,
  Forward,
  Reply,
  ReplyAll,
  Star,
  Trash,
  Warning,
} from '@/components/icons';
import { Button, Empty, IconButton, Pill, Progress } from '@/components/ui';
import { SenderAvatar } from '@/components/SenderAvatar';
import { bytes, displayName, fullDate, listDate } from '@/lib/format';
import { parseSearch, searchTerms } from '@/lib/search';
import { allowImagesFromSender, remoteImagesAllowed } from '@/lib/sender';
import { getApi } from '@/lib/api';
import { useAccountColor, useStore } from '@/lib/store';
import type { Attachment as AttachmentInfo, Id, Message } from '@/lib/types';
import { MessageBody } from './MessageBody';
import './reader.css';

export function Reader() {
  const openId = useStore((s) => s.openId);
  const message = useStore((s) => s.openMessage);
  const thread = useStore((s) => s.openThread);
  const loading = useStore((s) => s.readerLoading);
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);
  const colorOf = useAccountColor();
  const accounts = useStore((s) => s.accounts);
  // Re-opening the same message is the retry: `open` re-reads it, which makes
  // the server attempt the body fetch again.
  const reopen = useStore((s) => s.open);

  const [showHeaders, setShowHeaders] = useState(false);
  const [loadRemote, setLoadRemote] = useState(false);

  const scope = useStore((s) => s.query.scope);
  const terms = useMemo(
    () => (scope.kind === 'search' && scope.value ? searchTerms(parseSearch(scope.value)) : []),
    [scope.kind, scope.value],
  );

  // Reset per-message view state — otherwise "show images" leaks to the next.
  useEffect(() => {
    setShowHeaders(false);
    setLoadRemote(remoteImagesAllowed(prefs, message?.from));
  }, [openId, prefs, message?.from]);

  if (!openId) {
    return (
      <section className="reader-pane">
        <Empty
          title="Nothing open"
          body="Pick a message, or press ⌘K to jump anywhere. j and k move, Enter opens, e archives."
        />
      </section>
    );
  }

  if (!message) {
    return (
      <section className="reader-pane">
        <Progress />
      </section>
    );
  }

  const account = accounts.find((a) => a.id === message.accountId);
  const tint = colorOf(message.accountId);

  return (
    <section className="reader-pane" aria-label="Message">
      {loading && <Progress />}
      <ReaderBar message={message} />

      <div className="reader__scroll">
        <div className="reader__inner">
          <h1 className="reader__subject" data-selectable>
            {message.subject || '(no subject)'}
          </h1>

          <div className="reader__from">
            <SenderAvatar
              className="reader__avatar"
              sender={message.from}
              profiles={prefs?.senderProfiles ?? []}
              tint={tint}
            />
            <div className="reader__who">
              <div className="reader__name" data-selectable>
                {displayName(message.from)}
              </div>
              <div className="reader__addr" data-selectable>
                {message.from.address}
              </div>

              <div className="reader__badges">
                {account && <Pill tint={tint}>{account.label}</Pill>}
                {message.labels.map((l) => (
                  <Pill key={l} tint={prefs?.theme.labelColors[l] ?? null}>
                    {l}
                  </Pill>
                ))}
                {message.answered && <Pill>replied</Pill>}
              </div>
            </div>
            <div className="reader__when" title={new Date(message.date).toISOString()}>
              {fullDate(message.date)}
            </div>
          </div>

          {/* The envelope came from the local index and is real; only the body
              failed. Saying so beats an empty message, which is what a message
              with no content also looks like. */}
          {message.bodyError && (
            <div className="notice" data-tone="danger">
              <Warning size={14} />
              <span>{message.bodyError}</span>
              <div className="notice__actions">
                <Button size="sm" variant="outline" onClick={() => void reopen(message.id)}>
                  Try again
                </Button>
              </div>
            </div>
          )}

          {message.hasBlockedRemoteContent && !loadRemote && (
            <div className="notice">
              <Eye size={14} />
              <span>Remote images blocked — loading them tells the sender you opened this.</span>
              <div className="notice__actions">
                <Button size="sm" variant="outline" onClick={() => setLoadRemote(true)}>
                  Show images
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLoadRemote(true);
                    if (!prefs) return;
                    void savePrefs({
                      remoteImages: prefs.remoteImages === 'never' ? 'trusted' : prefs.remoteImages,
                      senderProfiles: allowImagesFromSender(message.from, prefs.senderProfiles),
                    });
                  }}
                >
                  Always allow {displayName(message.from)}
                </Button>
              </div>
            </div>
          )}

          <div className="reader__body">
            <MessageBody
              html={message.bodyHtml}
              text={message.bodyText}
              loadRemote={loadRemote}
              terms={terms}
            />
          </div>

          {message.attachments.length > 0 && (
            <div className="attachments">
              {message.attachments.map((a) => (
                <Attachment key={a.id} messageId={message.id} attachment={a} />
              ))}
            </div>
          )}

          {showHeaders && (
            <div className="headers">
              {Object.entries(message.headers).map(([k, v]) => (
                <div className="headers__row" key={k}>
                  <span className="headers__key">{k}</span>
                  <span className="headers__val">{v}</span>
                </div>
              ))}
            </div>
          )}

          {thread && thread.messages.length > 1 && <ThreadStrip thread={thread} openId={message.id} />}

          <QuickReply />

          <div style={{ marginTop: 'var(--s-7)' }}>
            <Button size="sm" onClick={() => setShowHeaders((v) => !v)}>
              {showHeaders ? 'Hide' : 'Show'} original headers
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Attachment ───────────────────────────────────────────────────────────────
   An anchor, not a button with a click handler. The browser then owns the save
   dialog, the progress indicator, and the retry — all of which would be worse
   if we rebuilt them, and none of which we need to. The URL is resolved lazily
   because the adapter arrives asynchronously. */

function Attachment({
  messageId,
  attachment,
}: {
  messageId: Id;
  attachment: AttachmentInfo;
}) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getApi().then((api) => {
      if (live) setHref(api.attachmentUrl(messageId, attachment.id));
    });
    return () => {
      live = false;
    };
  }, [messageId, attachment.id]);

  return (
    <a
      className="attachment"
      href={href ?? undefined}
      download={attachment.filename}
      aria-disabled={href ? undefined : true}
      title={`${attachment.filename} — ${attachment.mimeType}`}
    >
      <AttachIcon size={15} />
      <span style={{ minWidth: 0 }}>
        <span className="attachment__name">{attachment.filename}</span>
        <span className="attachment__size" style={{ display: 'block' }}>
          {bytes(attachment.size)}
        </span>
      </span>
    </a>
  );
}

/* ── Bar ──────────────────────────────────────────────────────────────────── */

function ReaderBar({ message }: { message: Message }) {
  const closeReader = useStore((s) => s.open);
  const openNext = useStore((s) => s.openNext);
  const toggleFlag = useStore((s) => s.toggleFlag);
  const toggleRead = useStore((s) => s.toggleRead);
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);
  const reply = useStore((s) => s.reply);
  const forward = useStore((s) => s.forward);
  // `?? []` inside the selector allocates a fresh array on every call whenever
  // the result is null, which is an infinite render loop — and null is exactly
  // the state a `/m/:id` deep link lands in before the list has loaded.
  const result = useStore((s) => s.result);
  const rows = result?.messages ?? [];
  const index = rows.findIndex((m) => m.id === message.id);

  return (
    <div className="reader__bar">
      <button
        type="button"
        className="reader__back"
        aria-label="Back to messages"
        onClick={() => void closeReader(null)}
      >
        <Chevron size={14} dir="left" />
        <span>Messages</span>
      </button>

      <span className="reader__back-divider" />

      <IconButton label="Reply" hint="r" onClick={() => reply(false)}>
        <Reply size={15} />
      </IconButton>
      <IconButton label="Reply all" hint="a" onClick={() => reply(true)}>
        <ReplyAll size={15} />
      </IconButton>
      <IconButton label="Forward" hint="f" onClick={forward}>
        <Forward size={15} />
      </IconButton>

      <span className="listbar__divider" />

      <IconButton label="Flag" hint="s" on={message.flagged} onClick={() => void toggleFlag([message.id])}>
        <Star size={15} filled={message.flagged} />
      </IconButton>
      <IconButton label="Mark unread" hint="u" onClick={() => void toggleRead([message.id])}>
        <Eye size={15} />
      </IconButton>
      <IconButton label="Snooze" hint="z">
        <Clock size={15} />
      </IconButton>
      <IconButton label="Archive" hint="e" onClick={() => void archive([message.id])}>
        <Archive size={15} />
      </IconButton>
      <IconButton label="Move to trash" hint="#" onClick={() => void trash([message.id])}>
        <Trash size={15} />
      </IconButton>

      <span className="reader__bar__spacer" />

      <div className="reader__nav">
        <IconButton label="Previous message" hint="k" disabled={index <= 0} onClick={() => void openNext(-1)}>
          <Chevron size={14} dir="up" />
        </IconButton>
        <span className="tnum">
          {index + 1}/{rows.length}
        </span>
        <IconButton
          label="Next message"
          hint="j"
          disabled={index >= rows.length - 1}
          onClick={() => void openNext(1)}
        >
          <Chevron size={14} dir="down" />
        </IconButton>
      </div>
    </div>
  );
}

/* ── Thread ───────────────────────────────────────────────────────────────── */

function ThreadStrip({ thread, openId }: { thread: NonNullable<ReturnType<typeof useStore.getState>['openThread']>; openId: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([openId]));
  const loadThreadBody = useStore((s) => s.loadThreadBody);

  /**
   * Expanding is what loads the body.
   *
   * The thread endpoint serves cached bodies only. Fetching all of them eagerly
   * would turn opening one message into an IMAP round trip per message in the
   * conversation, and most of them are never expanded.
   */
  const toggle = (m: Message) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) {
        next.delete(m.id);
      } else {
        next.add(m.id);
        if (m.bodyHtml === null && m.bodyText === null && !m.bodyError) {
          void loadThreadBody(m.id);
        }
      }
      return next;
    });

  return (
    <div className="thread">
      <div className="label" style={{ marginBottom: 'var(--s-4)' }}>
        Thread · {thread.messages.length} messages
      </div>
      {thread.messages.map((m) => {
        const open = expanded.has(m.id);
        const empty = m.bodyHtml === null && m.bodyText === null;
        return (
          <div className="thread__item" key={m.id} data-open={open}>
            <button
              type="button"
              className="thread__head"
              aria-expanded={open}
              onClick={() => toggle(m)}
            >
              <Chevron size={12} dir={open ? 'down' : 'right'} />
              <span className="thread__head__name">{displayName(m.from)}</span>
              <span className="thread__head__preview">{m.preview}</span>
              <span className="thread__head__date tnum">{listDate(m.date)}</span>
            </button>
            {open && (
              <div className="thread__body">
                {empty && !m.bodyError ? (
                  <Progress />
                ) : m.bodyError ? (
                  <div className="notice" data-tone="danger">
                    <Warning size={14} />
                    <span>{m.bodyError}</span>
                  </div>
                ) : (
                  <MessageBody html={m.bodyHtml} text={m.bodyText} loadRemote={false} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Quick reply ──────────────────────────────────────────────────────────── */

function QuickReply() {
  const reply = useStore((s) => s.reply);
  const forward = useStore((s) => s.forward);
  return (
    <div className="quickreply">
      <Button variant="outline" onClick={() => reply(false)}>
        <Reply size={14} />
        Reply
      </Button>
      <Button variant="outline" onClick={() => reply(true)}>
        <ReplyAll size={14} />
        Reply all
      </Button>
      <Button variant="outline" onClick={forward}>
        <Forward size={14} />
        Forward
      </Button>
    </div>
  );
}
