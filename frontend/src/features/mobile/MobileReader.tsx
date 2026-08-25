/**
 * The mobile reader. Full-screen, slides in over the list when a message is
 * open. Reuses `MessageBody` — the expensive, isolated part — and the store's
 * reader state, so opening on mobile and desktop is the same action. The
 * browser back button works because opening a message pushes history via the
 * shared router.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Attachment as AttachIcon,
  Chevron,
  Forward,
  Reply,
  Star,
  Trash,
  Warning,
} from '@/components/icons';
import { Button, Empty, IconButton, Pill, Progress } from '@/components/ui';
import { SenderAvatar } from '@/components/SenderAvatar';
import { SenderMenu } from '@/components/SenderMenu';
import { useContextMenu } from '@/components/context-menu';
import { addrList, bytes, displayName, fullDate, listDate, relative } from '@/lib/format';
import { parseSearch, searchTerms } from '@/lib/search';
import { allowImagesFromSender, remoteImagesAllowed } from '@/lib/sender';
import { getApi } from '@/lib/api';
import { useAccountColor, useStore } from '@/lib/store';
import type { Addr, Attachment as AttachmentInfo, Message } from '@/lib/types';
import { MessageBody } from '@/features/reader/MessageBody';

export function MobileReader() {
  const message = useStore((s) => s.openMessage);
  const thread = useStore((s) => s.openThread);
  const loading = useStore((s) => s.readerLoading);
  const colorOf = useAccountColor();
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);
  const close = useStore((s) => s.open);

  const scope = useStore((s) => s.query.scope);
  const terms = useMemo(
    () => (scope.kind === 'search' && scope.value ? searchTerms(parseSearch(scope.value)) : []),
    [scope.kind, scope.value],
  );

  const [loadRemote, setLoadRemote] = useState(false);
  const senderMenu = useContextMenu<Addr>();
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    setLoadRemote(remoteImagesAllowed(prefs, message?.from));
  }, [message?.id, prefs, message?.from]);

  if (!message) {
    return (
      <div className="mreader">
        <ReaderBar message={null} onBack={() => void close(null)} />
        {loading ? <Progress /> : <Empty title="Nothing open" body="Pick a message." />}
      </div>
    );
  }

  const account = accounts.find((a) => a.id === message.accountId);
  const tint = colorOf(message.accountId);

  return (
    <div className="mreader">
      <ReaderBar message={message} onBack={() => void close(null)} />

      <div className="mreader__scroll">
        <div className="mreader__inner">
          <h1 className="mreader__subject" data-selectable>
            {message.subject || '(no subject)'}
          </h1>

          {/*
            Metadata, triaged.

            Everything used to be laid out flat at one weight: full address, the
            whole recipient list, and an absolute date in a narrow right-hand
            column. On a 390px screen that wrapped to five or six ragged lines
            before the message had said anything. Now the two facts that place a
            message — who sent it and how long ago — get the first line to
            themselves, and everything else is one tappable line that opens the
            full envelope on demand.
          */}
          <div className="mreader__from">
            <SenderAvatar
              className="mreader__avatar"
              sender={message.from}
              profiles={prefs?.senderProfiles ?? []}
              tint={tint}
              onClick={(e) => senderMenu.onContextMenu(e, message.from)}
            />
            <div className="mreader__who">
              <div className="mreader__topline">
                <span className="mreader__name truncate" data-selectable>
                  {displayName(message.from)}
                </span>
                <span className="mreader__when" title={fullDate(message.date)}>
                  {relative(message.date)}
                </span>
              </div>

              <div className="mreader__addr truncate" data-selectable>
                {message.from.address}
              </div>

              <button
                type="button"
                className="mreader__recipients"
                aria-expanded={showDetail}
                onClick={() => setShowDetail((v) => !v)}
              >
                <span className="truncate">
                  to {addrList(message.to)}
                  {message.cc.length > 0 && ` · cc ${addrList(message.cc)}`}
                </span>
                <Chevron size={11} dir={showDetail ? 'up' : 'down'} />
              </button>

              {showDetail && (
                <dl className="mreader__envelope" data-selectable>
                  <dt>From</dt>
                  <dd>{message.from.address}</dd>
                  <dt>To</dt>
                  <dd>{message.to.map((a) => a.address).join(', ') || '—'}</dd>
                  {message.cc.length > 0 && (
                    <>
                      <dt>Cc</dt>
                      <dd>{message.cc.map((a) => a.address).join(', ')}</dd>
                    </>
                  )}
                  <dt>Date</dt>
                  <dd>{fullDate(message.date)}</dd>
                  {account && (
                    <>
                      <dt>Account</dt>
                      <dd>{account.address}</dd>
                    </>
                  )}
                </dl>
              )}

              <div className="mreader__badges">
                {account && <Pill tint={tint}>{account.label}</Pill>}
                {message.answered && <Pill>replied</Pill>}
              </div>
            </div>
          </div>

          {message.bodyError && (
            <div className="notice" data-tone="danger">
              <Warning size={14} />
              <span>{message.bodyError}</span>
            </div>
          )}

          {message.hasBlockedRemoteContent && !loadRemote && (
            <div className="notice">
              <span>Remote images blocked.</span>
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
                  Always allow
                </Button>
              </div>
            </div>
          )}

          <div className="mreader__body">
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

          {thread && thread.messages.length > 1 && <ThreadList thread={thread} openId={message.id} />}

          <QuickReply />
        </div>
      </div>

      <SenderMenu controller={senderMenu} />
    </div>
  );
}

/* ── Bar ──────────────────────────────────────────────────────────────────── */

function ReaderBar({ message, onBack }: { message: Message | null; onBack: () => void }) {
  const toggleFlag = useStore((s) => s.toggleFlag);
  const archive = useStore((s) => s.archive);
  const trash = useStore((s) => s.trash);
  const reply = useStore((s) => s.reply);
  const forward = useStore((s) => s.forward);

  return (
    <div className="mreader__bar">
      <IconButton label="Back" onClick={onBack}>
        <Chevron size={16} dir="left" />
      </IconButton>
      <span className="mreader__barname truncate">
        {message ? displayName(message.from) : 'Message'}
      </span>
      <div className="mreader__baracts">
        {message && (
          <>
            <IconButton label="Reply" onClick={() => reply(false)}>
              <Reply size={15} />
            </IconButton>
            <IconButton label="Forward" onClick={forward}>
              <Forward size={15} />
            </IconButton>
            <IconButton label="Pin" on={message.flagged} onClick={() => void toggleFlag([message.id])}>
              <Star size={15} filled={message.flagged} />
            </IconButton>
            <IconButton label="Archive" onClick={() => void archive([message.id])}>
              <Archive size={15} />
            </IconButton>
            <IconButton label="Move to trash" onClick={() => void trash([message.id])}>
              <Trash size={15} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Attachment ───────────────────────────────────────────────────────────── */

function Attachment({ messageId, attachment }: { messageId: string; attachment: AttachmentInfo }) {
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
    <a className="attachment" href={href ?? undefined} download={attachment.filename}>
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

/* ── Thread ───────────────────────────────────────────────────────────────── */

function ThreadList({
  thread,
  openId,
}: {
  thread: NonNullable<ReturnType<typeof useStore.getState>['openThread']>;
  openId: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([openId]));
  const loadThreadBody = useStore((s) => s.loadThreadBody);

  const toggle = (m: Message) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id);
      else {
        next.add(m.id);
        if (m.bodyHtml === null && m.bodyText === null && !m.bodyError) void loadThreadBody(m.id);
      }
      return next;
    });

  return (
    <div className="mthread">
      <div className="label" style={{ marginBottom: 'var(--s-4)' }}>
        Thread · {thread.messages.length} messages
      </div>
      {thread.messages.map((m) => {
        const open = expanded.has(m.id);
        return (
          <div className="mthread__item" key={m.id} data-open={open}>
            <button
              type="button"
              className="mthread__head"
              aria-expanded={open}
              onClick={() => toggle(m)}
            >
              <Chevron size={12} dir={open ? 'down' : 'right'} />
              <span className="mthread__head__name">{displayName(m.from)}</span>
              <span className="mthread__head__date tnum">{listDate(m.date)}</span>
            </button>
            {open && (
              <div className="mthread__body">
                {m.bodyHtml === null && m.bodyText === null && !m.bodyError ? (
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
    <div className="mquick">
      <Button variant="outline" onClick={() => reply(false)}>
        <Reply size={14} />
        Reply
      </Button>
      <Button variant="outline" onClick={() => reply(true)}>
        Reply all
      </Button>
      <Button variant="outline" onClick={forward}>
        <Forward size={14} />
        Forward
      </Button>
    </div>
  );
}
