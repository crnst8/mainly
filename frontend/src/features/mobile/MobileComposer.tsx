/**
 * The mobile composer.
 *
 * A screen, not a dialog. The docked composer is a floating 620x560 card with a
 * minimise control and a title bar, which on a phone became a shrunken window
 * hovering over the list — it kept the chrome of a desktop affordance and none
 * of its usefulness, since there is nothing to dock beside and nothing to keep
 * reading behind it.
 *
 * Three things this gets right that a scaled-down modal cannot:
 *
 *  - It owns the viewport. `position: fixed` over everything, no backdrop, no
 *    resize behaviour, no minimise. Back is the only way out and it asks before
 *    it throws work away.
 *  - It knows where the keyboard is. `useKeyboardInset` drives the send bar and
 *    the body's scroll padding, so nothing is ever typed underneath the
 *    keyboard — the single worst thing a mobile compose screen can do.
 *  - Its inputs are 16px and correctly typed. Under 16px iOS zooms the page on
 *    focus and does not zoom back, which is the "unexpected responsivity" that
 *    makes a web compose screen feel broken.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Chevron, Close, Plus, Send } from '@/components/icons';
import { EMAIL_RE, parseAddrs } from '@/lib/format';
import { useKeyboardInset } from '@/lib/media';
import { useAccountColor, useStore } from '@/lib/store';
import type { Addr, Draft } from '@/lib/types';
import { Sheet } from './Sheet';

/*
 * A wrapper whose only job is to unmount `Editor` when there is no draft.
 *
 * Holding the state here and returning `null` looked equivalent and is not:
 * returning null keeps the component mounted and its state alive, so closing a
 * draft and opening the next one brought the previous one's open sheets with
 * it — discard a draft, hit reply, and the "discard this draft?" sheet was
 * already sitting there over the new one. Unmounting is what resets it.
 */
export function MobileComposer() {
  const draft = useStore((s) => s.composer);
  return draft ? <Editor draft={draft} /> : null;
}

function Editor({ draft }: { draft: Draft }) {
  const close = useStore((s) => s.closeComposer);
  const send = useStore((s) => s.sendComposer);
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);
  const toast = useStore((s) => s.toast);
  const colorOf = useAccountColor();
  const kb = useKeyboardInset();

  const [showCc, setShowCc] = useState(false);
  const [fromOpen, setFromOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmNoSubject, setConfirmNoSubject] = useState(false);
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  /* Focus where the work starts: recipients on a new message, the body on a
     reply. Deliberately not autofocused on first paint of a reply — raising the
     keyboard before the screen has settled makes the whole thing lurch. */
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (draft.to.length) {
        bodyRef.current?.focus();
        bodyRef.current?.setSelectionRange(0, 0);
      } else {
        toRef.current?.focus();
      }
    }, 260);
    return () => window.clearTimeout(t);
  }, [draft?.id, draft?.inReplyTo]);

  // A hardware keyboard is not unheard of on a tablet, and the shortcut is free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void trySend();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const account = accounts.find((a) => a.id === draft.accountId);

  const dirty = useMemo(
    () =>
      (draft.to.length > 0 ||
        draft.cc.length > 0 ||
        draft.bcc.length > 0 ||
        draft.subject.trim() !== '' ||
        draft.bodyText.trim() !== ''),
    [draft],
  );

  const patch = (p: Partial<typeof draft>) =>
    useStore.setState({ composer: { ...draft, ...p } });

  const invalid = [...draft.to, ...draft.cc, ...draft.bcc].filter(
    (a) => !EMAIL_RE.test(a.address),
  );
  const canSend = draft.to.length > 0 && invalid.length === 0 && !sending;

  async function trySend() {
    if (sending) return;
    if (!draft.to.length) {
      toast('Add a recipient first');
      toRef.current?.focus();
      return;
    }
    if (invalid.length) {
      toast(`${invalid[0]!.address} is not an address`);
      return;
    }
    if (prefs?.sendGuards && !draft.subject.trim()) {
      // On a phone there is no second keystroke to lean on, so the guard is a
      // question with buttons rather than a toast that expects a repeat.
      setConfirmNoSubject(true);
      return;
    }
    setSending(true);
    // The keyboard has to go before the screen does, or it animates away over
    // the list underneath and drags the layout with it.
    (document.activeElement as HTMLElement | null)?.blur();
    await send();
    setSending(false);
  }

  const onBack = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    if (dirty) setConfirmDiscard(true);
    else close();
  };

  return (
    <div
      className="mcompose"
      role="dialog"
      aria-modal="true"
      aria-label={draft.inReplyTo ? 'Reply' : 'New message'}
      style={{ '--kb': `${kb}px` } as React.CSSProperties}
    >
      <header className="mcompose__bar">
        <button type="button" className="mcompose__back" aria-label="Back" onClick={onBack}>
          <Chevron size={16} dir="left" />
        </button>
        <span className="mcompose__title">
          {draft.inReplyTo ? 'Reply' : draft.forwardOf ? 'Forward' : 'New message'}
        </span>
        <button
          type="button"
          className="mcompose__send"
          disabled={!canSend}
          onClick={() => void trySend()}
        >
          <Send size={15} />
          {sending ? 'Sending' : 'Send'}
        </button>
      </header>

      <div className="mcompose__scroll">
        {/* From is a row of its own and never collapsed. With a dozen addresses
            across seven domains, sending from the wrong one is the costliest
            mistake this app can make, and it is silent. */}
        <button type="button" className="mcompose__from" onClick={() => setFromOpen(true)}>
          <span className="mcompose__label">From</span>
          <span
            className="mcompose__dot"
            style={{ '--tint': colorOf(draft.accountId) } as React.CSSProperties}
          />
          <span className="mcompose__fromaddr truncate">{account?.address}</span>
          <Chevron size={12} />
        </button>

        <Recipients
          label="To"
          value={draft.to}
          inputRef={toRef}
          onChange={(to) => patch({ to })}
          trailing={
            !showCc && (
              <button
                type="button"
                className="mcompose__cctoggle"
                onClick={() => setShowCc(true)}
              >
                <Plus size={12} />
                Cc
              </button>
            )
          }
        />

        {showCc && (
          <>
            <Recipients label="Cc" value={draft.cc} onChange={(cc) => patch({ cc })} />
            <Recipients label="Bcc" value={draft.bcc} onChange={(bcc) => patch({ bcc })} />
          </>
        )}

        <div className="mcompose__row">
          <span className="mcompose__label">Subject</span>
          <input
            className="mcompose__input"
            value={draft.subject}
            placeholder="Subject"
            enterKeyHint="next"
            autoCapitalize="sentences"
            onChange={(e) => patch({ subject: e.target.value })}
          />
        </div>

        <textarea
          ref={bodyRef}
          className="mcompose__body"
          value={draft.bodyText}
          placeholder="Write…"
          autoCapitalize="sentences"
          onChange={(e) => patch({ bodyText: e.target.value })}
        />
      </div>

      <Sheet open={fromOpen} onClose={() => setFromOpen(false)} title="Send from">
        <div className="sheet__list">
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              className="sheet__row"
              aria-current={a.id === draft.accountId}
              onClick={() => {
                patch({ accountId: a.id });
                setFromOpen(false);
              }}
            >
              <span
                className="mcompose__dot"
                style={{ '--tint': colorOf(a.id) } as React.CSSProperties}
              />
              <span className="sheet__rowlabel">
                {a.label}
                <span className="sheet__rowhint">{a.address}</span>
              </span>
              {a.id === draft.accountId && (
                <span className="sheet__rowcheck">
                  <Check size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this draft?"
      >
        <div className="mcompose__confirm">
          <p>It has not been sent and is not saved anywhere.</p>
          <button
            type="button"
            className="btn btn--danger mcompose__confirmbtn"
            onClick={() => {
              setConfirmDiscard(false);
              close();
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--outline mcompose__confirmbtn"
            onClick={() => setConfirmDiscard(false)}
          >
            Keep editing
          </button>
        </div>
      </Sheet>

      <Sheet
        open={confirmNoSubject}
        onClose={() => setConfirmNoSubject(false)}
        title="Send without a subject?"
      >
        <div className="mcompose__confirm">
          <p>The message has no subject line.</p>
          <button
            type="button"
            className="btn btn--accent mcompose__confirmbtn"
            onClick={async () => {
              setConfirmNoSubject(false);
              setSending(true);
              (document.activeElement as HTMLElement | null)?.blur();
              await send();
              setSending(false);
            }}
          >
            Send anyway
          </button>
          <button
            type="button"
            className="btn btn--outline mcompose__confirmbtn"
            onClick={() => setConfirmNoSubject(false)}
          >
            Add one
          </button>
        </div>
      </Sheet>
    </div>
  );
}

/* ── Recipients ───────────────────────────────────────────────────────────── */

function Recipients({
  label,
  value,
  onChange,
  inputRef,
  trailing,
}: {
  label: string;
  value: Addr[];
  onChange: (v: Addr[]) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState('');

  const commit = (raw: string) => {
    const parsed = parseAddrs(raw);
    if (parsed.length) onChange([...value, ...parsed]);
    setText('');
  };

  return (
    <div className="mcompose__row mcompose__row--recip">
      <span className="mcompose__label">{label}</span>
      <div className="mcompose__chips">
        {value.map((a, i) => (
          <span
            key={`${a.address}-${i}`}
            className="mchip"
            data-invalid={!EMAIL_RE.test(a.address) || undefined}
          >
            {a.name ?? a.address}
            <button type="button" aria-label={`Remove ${a.address}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Close size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="mcompose__input mcompose__input--chip"
          value={text}
          placeholder={value.length ? '' : 'name@domain'}
          /* The four attributes that decide whether typing an address on a
             phone is bearable. Without them the keyboard has no @, and the
             first character of every address is capitalised and autocorrected
             into a different word. */
          type="email"
          inputMode="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          onChange={(e) => {
            const v = e.target.value;
            // A separator commits the token; on a phone that is the whole
            // interaction, because Enter closes the keyboard instead.
            if (/[,;]\s*$/.test(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
              e.preventDefault();
              commit(text);
            }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && commit(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;<\n]/.test(pasted)) {
              e.preventDefault();
              commit(pasted);
            }
          }}
        />
      </div>
      {trailing}
    </div>
  );
}
