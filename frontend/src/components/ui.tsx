import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { splitOnTerms } from '@/lib/highlight';
import { Check, Close } from './icons';
import './ui.css';

/* ── Button ───────────────────────────────────────────────────────────────── */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'outline' | 'primary' | 'accent' | 'danger';
  size?: 'sm' | 'md';
  block?: boolean;
};

export function Button({ variant = 'ghost', size = 'md', block, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} ${size === 'sm' ? 'btn--sm' : ''} ${block ? 'btn--block' : ''} ${className}`}
      {...rest}
    />
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  on?: boolean;
  hint?: string;
};

export function IconButton({ label, on, hint, className = '', children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`iconbtn ${className}`}
      aria-label={label}
      title={hint ? `${label} · ${hint}` : label}
      data-on={on ? 'true' : undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Segmented ────────────────────────────────────────────────────────────── */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__item"
          aria-pressed={value === o.value}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Pill / Kbd ───────────────────────────────────────────────────────────── */

export function Pill({
  tint,
  solid,
  children,
}: {
  tint?: string | null;
  solid?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`pill ${tint ? 'pill--tinted' : ''} ${solid ? 'pill--solid' : ''}`}
      style={tint ? ({ '--tint': tint } as React.CSSProperties) : undefined}
    >
      {children}
    </span>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

/* ── Highlight ────────────────────────────────────────────────────────────── */

/** Text with search matches marked. Renders a bare string when nothing hits, so
 *  the common case adds no elements to a virtualised row. */
export function Mark({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const parts = splitOnTerms(text, terms);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark className="hit" key={i}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/* ── Field ────────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field__label">
        <span className="label">{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </div>
      {children}
      {error && (
        <span className="field__hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </div>
  );
}

/* ── Toggle ───────────────────────────────────────────────────────────────── */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

/* ── Settings row ─────────────────────────────────────────────────────────── */

export function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__title">{title}</div>
        {desc && <div className="row__desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/* ── Popover ──────────────────────────────────────────────────────────────
   Anchored to the trigger, flipped when it would clip, closed on outside click
   or Escape. Portalled so it is never trapped by an overflow:hidden ancestor. */

export function Popover({
  trigger,
  children,
  align = 'start',
  width,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const w = width ?? popRef.current?.offsetWidth ?? 220;
    const h = popRef.current?.offsetHeight ?? 240;
    const left = align === 'end' ? r.right - w : r.left;
    const flip = r.bottom + h + 8 > window.innerHeight;
    setPos({
      top: flip ? Math.max(8, r.top - h - 6) : r.bottom + 6,
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
    });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, ref: anchorRef })}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="pop"
            style={{ top: pos.top, left: pos.left, width }}
            role="menu"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function PopItem({
  checked,
  onClick,
  children,
  icon,
}: {
  checked?: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pop__item"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{children}</span>
      {checked !== undefined && (
        <span className="pop__item__check">
          <Check size={13} />
        </span>
      )}
    </button>
  );
}

export const PopSep = () => <div className="pop__sep" />;
export const PopLabel = ({ children }: { children: ReactNode }) => (
  <div className="pop__label label">{children}</div>
);

/* ── Modal ────────────────────────────────────────────────────────────────── */

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { maxWidth: width } : undefined} role="dialog" aria-modal="true">
        <div className="modal__head">
          <div className="modal__title">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <Close />
          </IconButton>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ── Empty state ──────────────────────────────────────────────────────────── */

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {body && <p className="empty__body">{body}</p>}
      {action}
    </div>
  );
}

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const Progress = () => <div className="progress" role="progressbar" aria-label="Working" />;
