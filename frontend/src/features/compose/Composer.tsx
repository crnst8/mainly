/**
 * Docked composer. Non-modal by design — you can keep reading and navigating
 * while a draft is open.
 *
 * The From picker is prominent rather than tucked away: with a dozen addresses
 * across seven domains, sending from the wrong one is the costliest mistake
 * this app can make, and it is silent.
 */

import { useEffect, useRef, useState } from 'react';
import { Chevron, Close, Send } from '@/components/icons';
import { Button, IconButton, Kbd, PopItem, PopLabel, Popover } from '@/components/ui';
import { useStore } from '@/lib/store';
import type { Addr } from '@/lib/types';
import './compose.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Composer() {
  const draft = useStore((s) => s.composer);
  const minimised = useStore((s) => s.composerMinimised);
  const close = useStore((s) => s.closeComposer);
  const send = useStore((s) => s.sendComposer);
  const accounts = useStore((s) => s.accounts);
  const prefs = useStore((s) => s.prefs);
  const toast = useStore((s) => s.toast);

  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  // Focus where the work actually starts: recipients on a new mail, the body
  // on a reply (recipients are already right).
  useEffect(() => {
    if (!draft) return;
    const target = draft.to.length ? bodyRef.current : toRef.current;
    target?.focus();
    if (draft.to.length && bodyRef.current) bodyRef.current.setSelectionRange(0, 0);
  }, [draft?.id, draft?.inReplyTo]);

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void trySend();
      }
      if (e.key === 'Escape' && document.activeElement?.tagName !== 'INPUT') {
        e.stopPropagation();
        useStore.setState({ composerMinimised: true });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!draft) return null;

  const account = accounts.find((a) => a.id === draft.accountId);
  const tint = account?.color ?? prefs?.theme.domainColors[account?.domain ?? ''] ?? 'var(--n-6)';
  const patch = (p: Partial<typeof draft>) => useStore.setState({ composer: { ...draft, ...p } });

  async function trySend() {
    if (!draft) return;
    if (!draft.to.length) {
      toast('Add a recipient first');
      toRef.current?.focus();
      return;
    }
    if (prefs?.sendGuards && !draft.subject.trim()) {
      toast('No subject — press ⌘↵ again to send anyway');
      // Second press within the toast window goes through.
      useStore.setState({ prefs: prefs ? { ...prefs, sendGuards: false } : prefs });
      setTimeout(() => useStore.setState((s) => ({ prefs: s.prefs ? { ...s.prefs, sendGuards: true } : s.prefs })), 6000);
      return;
    }
    await send();
  }

  const title = draft.subject || (draft.inReplyTo ? 'Reply' : 'New message');

  return (
    <div className="composer" data-minimised={minimised}>
      <div className="composer__head" onDoubleClick={() => useStore.setState({ composerMinimised: !minimised })}>
        <span className="composer__title">{title}</span>
        <IconButton
          label={minimised ? 'Expand' : 'Minimise'}
          onClick={() => useStore.setState({ composerMinimised: !minimised })}
        >
          <Chevron size={14} dir={minimised ? 'up' : 'down'} />
        </IconButton>
        <IconButton label="Discard" onClick={close}>
          <Close size={14} />
        </IconButton>
      </div>

      {!minimised && (
        <>
          <div className="composer__fields">
            <div className="composer__field">
              <span className="composer__field__label">From</span>
              <Popover
                trigger={(p) => (
                  <button type="button" className="composer__from" {...p}>
                    <span className="composer__from__dot" style={{ '--tint': tint } as React.CSSProperties} />
                    <span>{account?.displayName}</span>
                    <span className="composer__from__addr">{account?.address}</span>
                    <Chevron size={11} />
                  </button>
                )}
              >
                {(closePop) => (
                  <>
                    <PopLabel>Send from</PopLabel>
                    {accounts.map((a) => (
                      <PopItem
                        key={a.id}
                        checked={a.id === draft.accountId}
                        onClick={() => {
                          patch({ accountId: a.id });
                          closePop();
                        }}
                      >
                        {a.label}
                        <span className="nav__count" style={{ marginLeft: 'auto', paddingLeft: 12 }}>
                          {a.address}
                        </span>
                      </PopItem>
                    ))}
                  </>
                )}
              </Popover>
            </div>

            <RecipientField
              label="To"
              value={draft.to}
              inputRef={toRef}
              onChange={(to) => patch({ to })}
              extra={
                <div className="composer__field__extra">
                  {!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}
                  {!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}
                </div>
              }
            />

            {showCc && <RecipientField label="Cc" value={draft.cc} onChange={(cc) => patch({ cc })} />}
            {showBcc && <RecipientField label="Bcc" value={draft.bcc} onChange={(bcc) => patch({ bcc })} />}

            <div className="composer__field">
              <span className="composer__field__label">Subj</span>
              <input
                value={draft.subject}
                placeholder="Subject"
                onChange={(e) => patch({ subject: e.target.value })}
              />
            </div>
          </div>

          <textarea
            ref={bodyRef}
            className="composer__body"
            value={draft.bodyText}
            placeholder="Write…"
            onChange={(e) => patch({ bodyText: e.target.value })}
          />

          <div className="composer__foot">
            <Button variant="accent" onClick={() => void trySend()}>
              <Send size={14} />
              Send
            </Button>
            <span className="composer__status">
              <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
            </span>
            <span className="composer__foot__spacer" />
            <span className="composer__status">Draft saved</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Recipients ───────────────────────────────────────────────────────────── */

function RecipientField({
  label,
  value,
  onChange,
  extra,
  inputRef,
}: {
  label: string;
  value: Addr[];
  onChange: (v: Addr[]) => void;
  extra?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState('');

  /** Accepts anything a human might paste: bare addresses, "Name <addr>",
   *  comma-, semicolon-, or space-separated. Postel's law, applied literally. */
  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed: Addr[] = [];
    for (const p of parts) {
      const angle = /^(.*?)\s*<([^>]+)>$/.exec(p);
      if (angle) parsed.push({ name: angle[1]!.replace(/^["']|["']$/g, '') || null, address: angle[2]! });
      else parsed.push({ name: null, address: p });
    }
    if (parsed.length) onChange([...value, ...parsed]);
    setText('');
  };

  return (
    <div className="composer__field">
      <span className="composer__field__label">{label}</span>
      <div className="recips">
        {value.map((a, i) => (
          <span key={`${a.address}-${i}`} className={`recip ${EMAIL_RE.test(a.address) ? '' : 'recip--invalid'}`}>
            {a.name ?? a.address}
            <button
              type="button"
              aria-label={`Remove ${a.address}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Close size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          style={{ flex: 1, minWidth: 120 }}
          placeholder={value.length ? '' : 'name@domain'}
          onChange={(e) => {
            const v = e.target.value;
            // Typing a separator commits the token — no need to press Enter.
            if (/[,;]\s*$/.test(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') {
              if (text.trim()) {
                e.preventDefault();
                commit(text);
              }
            }
            if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && commit(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;<]/.test(pasted)) {
              e.preventDefault();
              commit(pasted);
            }
          }}
        />
      </div>
      {extra}
    </div>
  );
}
