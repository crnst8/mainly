/**
 * Right-click menus.
 *
 * Shares the popover's visual language — same surface, same items, same
 * separators — because a menu that appears under the cursor and a menu that
 * drops from a button are the same object in different clothes, and having them
 * look different would be arbitrary. What differs is anchoring (a point, not an
 * element) and dismissal (a second right-click elsewhere must move the menu, not
 * merely close it).
 *
 * `useContextMenu` owns the state; `ContextMenu` draws it. They are separate so
 * a list of five hundred rows registers one handler and renders one menu, rather
 * than mounting five hundred menus that are almost always closed.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuTarget<T> {
  x: number;
  y: number;
  /** Whatever the caller needs to build the menu — a message, a folder, an id. */
  subject: T;
}

export interface ContextMenuController<T> {
  open: MenuTarget<T> | null;
  /** Attach to `onContextMenu`. Prevents the browser menu and records the point. */
  onContextMenu: (e: React.MouseEvent, subject: T) => void;
  close: () => void;
}

export function useContextMenu<T>(): ContextMenuController<T> {
  const [open, setOpen] = useState<MenuTarget<T> | null>(null);

  const onContextMenu = useCallback((e: React.MouseEvent, subject: T) => {
    e.preventDefault();
    // Right-clicking inside an already-open menu is the browser's business, not
    // ours — otherwise the menu re-anchors to itself.
    e.stopPropagation();
    setOpen({ x: e.clientX, y: e.clientY, subject });
  }, []);

  return { open, onContextMenu, close: useCallback(() => setOpen(null), []) };
}

/* ── The menu ─────────────────────────────────────────────────────────────── */

export function ContextMenu<T>({
  controller,
  width = 232,
  children,
}: {
  controller: ContextMenuController<T>;
  width?: number;
  children: (subject: T, close: () => void) => ReactNode;
}) {
  const { open, close } = controller;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  /* Flip and clamp so the menu is always fully on screen — the pointer is often
     near an edge precisely because that is where the row ends. Measured after
     mount, because the height depends on what the caller rendered. */
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(open.x, window.innerWidth - w - pad)),
      top:
        open.y + h + pad > window.innerHeight
          ? Math.max(pad, open.y - h)
          : open.y,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Roving focus. A menu you can open with the keyboard (Shift+F10, the
      // menu key) but not move through is not keyboard accessible.
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
    };

    // `true` so a scroll anywhere closes it before the menu detaches from the
    // row it belongs to.
    const onScroll = () => close();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      className="pop pop--ctx"
      style={{ top: pos.top, left: pos.left, width }}
      role="menu"
      // Right-clicking the menu itself should not open a second one behind it.
      onContextMenu={(e) => e.preventDefault()}
    >
      {children(open.subject, close)}
    </div>,
    document.body,
  );
}

/* ── Items ────────────────────────────────────────────────────────────────── */

/**
 * A plain action. Distinct from `PopItem`, which is `menuitemradio` and always
 * reserves room for a tick — correct for a sort menu where exactly one option is
 * live, wrong for "Archive", which is a verb and not a state.
 */
export function MenuItem({
  onClick,
  icon,
  hint,
  danger,
  disabled,
  children,
}: {
  onClick: () => void;
  icon?: ReactNode;
  /** Shortcut or side note, right-aligned and quiet. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pop__item"
      role="menuitem"
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <span className="pop__item__icon">{icon}</span>}
      <span className="truncate">{children}</span>
      {hint && <span className="pop__item__hint">{hint}</span>}
    </button>
  );
}

/** A toggle. Carries its state in `aria-checked` so the tick is not the only
 *  thing saying so. */
export function MenuToggle({
  checked,
  onClick,
  icon,
  swatch,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  icon?: ReactNode;
  /** Colour chip, for labels. */
  swatch?: string | null;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pop__item"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      {swatch !== undefined ? (
        <span className="pop__item__swatch" style={{ background: swatch ?? 'var(--n-6)' }} />
      ) : (
        icon && <span className="pop__item__icon">{icon}</span>
      )}
      <span className="truncate">{children}</span>
      <span className="pop__item__check" aria-hidden>
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}

/**
 * A nested menu.
 *
 * Opens on hover *and* on click, and stays open while the pointer is anywhere
 * in the parent item or the submenu. Hover-only submenus are unusable with a
 * trackpad and unreachable from a keyboard.
 */
export function MenuSub({
  label,
  icon,
  children,
  width = 236,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const closeTimer = useRef<number | null>(null);

  const hold = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // A short grace period, so a diagonal move from the parent item to the panel
  // does not close what it is heading for.
  const release = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  useLayoutEffect(() => {
    if (!open || !hostRef.current) return;
    const r = hostRef.current.getBoundingClientRect();
    const h = panelRef.current?.offsetHeight ?? 260;
    const pad = 8;
    // Flip to the left when there is no room on the right.
    const left = r.right + width + pad > window.innerWidth ? r.left - width : r.right;
    setPos({
      left: Math.max(pad, left),
      top: Math.max(pad, Math.min(r.top, window.innerHeight - h - pad)),
    });
  }, [open, width]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  return (
    <div ref={hostRef} onMouseEnter={hold} onMouseLeave={release}>
      <button
        type="button"
        className="pop__item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={hold}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            hold();
            // Focus the first item once the panel has rendered.
            requestAnimationFrame(() =>
              panelRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus(),
            );
          }
        }}
      >
        {icon && <span className="pop__item__icon">{icon}</span>}
        <span className="truncate">{label}</span>
        <span className="pop__item__more" aria-hidden>
          ›
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="pop pop--ctx"
            style={{ top: pos.top, left: pos.left, width }}
            role="menu"
            onMouseEnter={hold}
            onMouseLeave={release}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setOpen(false);
                hostRef.current?.querySelector('button')?.focus();
              }
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
