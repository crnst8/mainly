/**
 * Bottom sheet primitive — the mobile equivalent of a modal.
 *
 * Lives here and not in `components/` because only this feature uses it
 * (AGENTS.md §2). Dragging the handle dismisses; tapping the backdrop or
 * pressing Escape closes. The content stays mounted while it animates out so
 * the exit transition is visible, then unmounts on the parent's side.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startH: number } | null>(null);
  const reduced = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    // Focus the sheet so Tab is trapped inside it.
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = Math.max(0, e.clientY - d.startY);
    const el = ref.current;
    if (el) el.style.transform = `translateY(${dy}px)`;
    if (dy > 120 && !reduced.current) {
      onPointerUp();
    }
  };

  const onPointerUp = () => {
    const el = ref.current;
    if (el) el.style.transform = '';
    drag.current = null;
  };

  if (!open) return null;

  return createPortal(
    <div className="sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={(e) => e.target === e.currentTarget && e.stopPropagation()}
      >
        <button
          type="button"
          className="sheet__handle"
          aria-label="Drag to close"
          onPointerDown={(e) => {
            drag.current = { startY: e.clientY, startH: 0 };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onClose}
        />
        <div className="sheet__title label">{title}</div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
