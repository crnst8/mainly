import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Attachment as AttachIcon,
  Chevron,
  Clock,
  Contrast,
  Eye,
  Forward,
  Printer,
  Reply,
  ReplyAll,
  Star,
  Trash,
  Warning,
} from '@/components/icons';
import { Button, Empty, IconButton, Pill, PopItem, PopLabel, Popover, Progress } from '@/components/ui';
import { SenderAvatar } from '@/components/SenderAvatar';
import { SenderMenu } from '@/components/SenderMenu';
import { useContextMenu } from '@/components/context-menu';
import { bytes, displayName, fullDate, listDate } from '@/lib/format';
import { parseSearch, searchTerms } from '@/lib/search';
import { allowImagesFromSender } from '@/lib/sender';
import { getApi } from '@/lib/api';
import { useAccountColor, useMailDark, useShowRemote, useStore, useThemeIsDark } from '@/lib/store';
import type { Addr, Attachment as AttachmentInfo, Id, Message, PrintColors } from '@/lib/types';
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
  const loadRemote = useShowRemote();
  const setLoadRemote = useStore((s) => s.setMailRemote);
  const mailDark = useMailDark();
  const onDark = useThemeIsDark();
  const senderMenu = useContextMenu<Addr>();

  const scope = useStore((s) => s.query.scope);
  const terms = useMemo(
    () => (scope.kind === 'search' && scope.value ? searchTerms(parseSearch(scope.value)) : []),
    [scope.kind, scope.value],
  );

  // "Show original headers" is the last piece of per-message view state still
  // held here; it has no preference behind it and nothing else reads it. The
  // other two — images and colours — are reset by `open` itself, in the store.
  useEffect(() => setShowHeaders(false), [openId]);

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
              onClick={(e) => senderMenu.onContextMenu(e, message.from)}
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
              relit={mailDark}
              surface={onDark ? 'dark' : 'light'}
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

          {thread && thread.messages.length > 1 && (
            <ThreadStrip thread={thread} openId={message.id} relit={mailDark} surface={onDark ? 'dark' : 'light'} />
          )}

          <QuickReply />

          <div style={{ marginTop: 'var(--s-7)' }}>
            <Button size="sm" onClick={() => setShowHeaders((v) => !v)}>
              {showHeaders ? 'Hide' : 'Show'} original headers
            </Button>
          </div>
        </div>
      </div>

      <SenderMenu controller={senderMenu} />
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

      <span className="listbar__divider" />

      <MailColorsToggle />
      <PrintButton />

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

/* ── Colour and paper ─────────────────────────────────────────────────────────
   Two controls that answer the same question — what should the sender's
   colours become — for two destinations, a dark screen and a sheet of paper. */

/**
 * One click back to the message as it was sent, and one click forward again.
 *
 * The requirement was "quick and easy", which rules out a menu: this is a
 * button that is either lit or not, in the toolbar, next to the message it
 * describes. It is a per-message answer and it does not stick, so pressing it
 * to check a colour swatch cannot quietly become a setting — the preference
 * for that lives in Appearance.
 */
function MailColorsToggle() {
  const dark = useMailDark();
  const override = useStore((s) => s.mailOverride);
  const setOverride = useStore((s) => s.setMailOverride);
  const message = useStore((s) => s.openMessage);

  // A plaintext body is drawn by the app in the app's own tokens. There is
  // nothing of the sender's to re-light and nothing the button could change.
  if (!message?.bodyHtml) return null;

  return (
    <IconButton
      label={dark ? 'Show original colours' : 'Fit colours to dark mode'}
      hint="i"
      on={dark}
      // A one-off is announced, because the row above it just changed and the
      // reason should not be a mystery.
      title={
        override === null
          ? undefined
          : `${dark ? 'Re-lit' : 'Original colours'} — this message only`
      }
      onClick={() => setOverride(!dark)}
    >
      <Contrast size={15} />
    </IconButton>
  );
}

/**
 * Print, with the colour decision attached.
 *
 * The button prints straight away using the stored default — one click, which
 * is the whole point when the thing being printed is a receipt. The chevron is
 * for the other mode, and it is a separate hit target rather than a menu that
 * every print has to pass through.
 */
function PrintButton() {
  const printOpen = useStore((s) => s.printOpen);
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);
  const preferred = prefs?.printColors ?? 'paper';

  const choose = (colors: PrintColors, close: () => void) => {
    close();
    if (colors !== preferred) void savePrefs({ printColors: colors });
    printOpen(colors);
  };

  return (
    <span className="reader__print">
      <IconButton label="Print" hint="⌘P" onClick={() => printOpen()}>
        <Printer size={15} />
      </IconButton>
      <Popover
        align="start"
        width={264}
        trigger={(p) => (
          <button type="button" className="reader__print__more" aria-label="Print options" {...p}>
            <Chevron size={11} dir="down" />
          </button>
        )}
      >
        {(close) => (
          <>
            <PopLabel>Print colours</PopLabel>
            <PopItem
              checked={preferred === 'paper'}
              icon={<Printer size={15} />}
              onClick={() => choose('paper', close)}
            >
              Paper — black on white
            </PopItem>
            <PopItem
              checked={preferred === 'original'}
              icon={<Contrast size={15} />}
              onClick={() => choose('original', close)}
            >
              As sent — original colours
            </PopItem>
            <div className="reader__print__note">
              Choose <strong>Save as PDF</strong> in the print dialog to keep a receipt that came
              in the body with nothing attached.
            </div>
          </>
        )}
      </Popover>
    </span>
  );
}

/* ── Thread ───────────────────────────────────────────────────────────────── */

function ThreadStrip({
  thread,
  openId,
  relit,
  surface,
}: {
  thread: NonNullable<ReturnType<typeof useStore.getState>['openThread']>;
  openId: string;
  relit: boolean;
  surface: 'light' | 'dark';
}) {
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
                  <MessageBody
                    html={m.bodyHtml}
                    text={m.bodyText}
                    loadRemote={false}
                    relit={relit}
                    surface={surface}
                  />
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
