/**
 * Global keyboard map.
 *
 * Conventions people already know (Jakob's law): j/k to move, Enter to open,
 * e to archive, # to trash, / to search, ⌘K for everything else. Nothing here
 * needs to be learned by anyone who has used mail in a terminal or in Gmail.
 *
 * Sequences (g then i) are supported with a 900ms window so "go to inbox" does
 * not need a modifier.
 */

import { useEffect, useRef } from 'react';
import { homeScope } from './scope';
import { mailDarkNow, useStore } from './store';
import type { Scope } from './types';

const SEQUENCE_MS = 900;

/** True when a keystroke belongs to whatever the user is typing into. */
function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export function useKeyboard() {
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      /* ── Always available ─────────────────────────────────────────────── */

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.setPalette(!s.palette);
        return;
      }

      // The reader body is selectable text inside a shadow root, so its event
      // target is retargeted to the host before it reaches this document
      // listener. Preserve the platform copy shortcut instead of treating its
      // `c` as the compose key.
      if (mod && e.key.toLowerCase() === 'c') return;

      // Let the browser handle its platform reload shortcut. A reload starts
      // the app afresh and re-fetches the mailbox data instead of replying.
      if (mod && e.key.toLowerCase() === 'r') return;

      // ⌘P means "print this", and in a mail client "this" is the message —
      // never the client. Claimed only with a message open, so ⌘P everywhere
      // else still reaches the browser and prints whatever is on screen.
      if (mod && e.key.toLowerCase() === 'p' && s.openMessage) {
        e.preventDefault();
        return s.printOpen();
      }

      if (e.key === 'Escape') {
        if (s.palette) return s.setPalette(false);
        if (s.help) return s.setHelp(null);
        if (s.settings) return s.setSettings(null);
        if (s.selectedIds.size) return s.clearSelection();
        if (s.openId) return void s.open(null);
        return;
      }

      // Everything below is for the app surface, not for form fields.
      if (inEditable(e.target)) return;
      if (s.palette || s.help || s.settings || s.onboarding) return;

      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        return s.selectAll();
      }

      /* ── Sequences ────────────────────────────────────────────────────── */

      const prev = pending.current;
      if (prev && Date.now() - prev.at < SEQUENCE_MS) {
        pending.current = null;
        if (prev.key === 'g') {
          e.preventDefault();
          // Home is its own key rather than an alias of `g i`: from a domain's
          // sent folder, "go to inbox" and "go home" are different places, and
          // conflating them makes one of them unreachable.
          if (e.key === 'h') return s.goHome();
          const roles = { i: 'inbox', d: 'drafts', s: 'sent', a: 'archive', t: 'trash', j: 'junk' } as const;
          const role = roles[e.key as keyof typeof roles];
          if (role) return s.setScope({ ...rolefulScope(s), role });
          if (e.key === 'g') return s.setScope({ ...rolefulScope(s), role: null });
          return;
        }
      }

      if (e.key === 'g' && !mod) {
        pending.current = { key: 'g', at: Date.now() };
        return;
      }

      /* ── Single keys ──────────────────────────────────────────────────── */

      switch (e.key) {
        // The capital is shift+j, which the browser reports as a different key
        // rather than as `j` with a modifier. It is listed beside the lowercase
        // one and still reads `shiftKey`, so Caps Lock — which also sends `J`,
        // with no shift — keeps moving rather than silently selecting.
        case 'j':
        case 'J':
        case 'ArrowDown':
          e.preventDefault();
          // Shift is the keyboard's shift-click: it grows the selection from
          // wherever it was anchored rather than moving alone.
          return s.moveFocus(1, e.shiftKey);
        case 'k':
        case 'K':
        case 'ArrowUp':
          e.preventDefault();
          return s.moveFocus(-1, e.shiftKey);
        case 'Enter':
          e.preventDefault();
          return void s.open(s.focusedId);
        case 'x':
          e.preventDefault();
          if (s.focusedId) s.toggleSelect(s.focusedId, 'add');
          return;
        case 'u':
          e.preventDefault();
          return void s.toggleRead();
        case 's':
          e.preventDefault();
          return void s.toggleFlag();
        case 'e':
          e.preventDefault();
          return void s.archive();
        case '#':
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          return void s.trash();
        case 'c':
          e.preventDefault();
          return s.compose();
        case 'r':
          e.preventDefault();
          if (s.openMessage) return s.reply(false);
          return void s.refresh();
        case 'a':
          e.preventDefault();
          if (s.openMessage) return s.reply(true);
          return;
        case 'f':
          e.preventDefault();
          if (s.openMessage) return s.forward();
          return;
        case 'i':
          e.preventDefault();
          // Invert. One key, straight back to the message as it was sent, and
          // the same key forward again — the toggle the toolbar button is.
          if (s.openMessage) return s.setMailOverride(!mailDarkNow(s));
          return;
        case 'p':
          e.preventDefault();
          if (s.openMessage) return s.printOpen();
          return;
        case '/':
          e.preventDefault();
          document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
          return;
        case ',':
          e.preventDefault();
          return s.setSettings('appearance');
        case '?':
          e.preventDefault();
          return s.setHelp('shortcuts');
        case 'z': {
          e.preventDefault();
          // Undo the most recent reversible toast.
          const undoable = [...s.toasts].reverse().find((t) => t.undo);
          if (undoable) {
            undoable.undo!();
            s.dismissToast(undoable.id);
          }
          return;
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * The scope a `g <role>` jump applies to.
 *
 * Role jumps stay inside where you are — from bigchungus.holdings, `g s` is that domain's
 * sent mail, not everyone's. A folder, a search and a saved view have no role
 * axis to move along, so from those it means the unified view.
 */
function rolefulScope(s: ReturnType<typeof useStore.getState>): Scope {
  const { scope } = s.query;
  return scope.kind === 'domain' || scope.kind === 'account' || scope.kind === 'unified'
    ? scope
    : homeScope();
}

/** Rendered in settings and in the palette footer. Single source of truth. */
export const SHORTCUTS: { keys: string[]; label: string; group: string }[] = [
  { keys: ['j'], label: 'Next message', group: 'Navigate' },
  { keys: ['k'], label: 'Previous message', group: 'Navigate' },
  { keys: ['↵'], label: 'Open', group: 'Navigate' },
  { keys: ['Esc'], label: 'Close / clear selection', group: 'Navigate' },
  { keys: ['g', 'h'], label: 'Go home — all mail', group: 'Navigate' },
  { keys: ['g', 'i'], label: 'Inbox, here', group: 'Navigate' },
  { keys: ['g', 'd'], label: 'Drafts, here', group: 'Navigate' },
  { keys: ['g', 's'], label: 'Sent, here', group: 'Navigate' },
  { keys: ['g', 'a'], label: 'Archive, here', group: 'Navigate' },
  { keys: ['g', 'g'], label: 'Every folder, here', group: 'Navigate' },
  { keys: ['/'], label: 'Search', group: 'Navigate' },
  { keys: ['⌘', 'K'], label: 'Command palette', group: 'Navigate' },

  { keys: ['x'], label: 'Select', group: 'Act' },
  { keys: ['⇧', 'j'], label: 'Extend selection down', group: 'Act' },
  { keys: ['⇧', 'k'], label: 'Extend selection up', group: 'Act' },
  { keys: ['⇧', 'click'], label: 'Select everything between', group: 'Act' },
  { keys: ['⌘', 'A'], label: 'Select all', group: 'Act' },
  { keys: ['u'], label: 'Toggle read', group: 'Act' },
  { keys: ['s'], label: 'Toggle flag', group: 'Act' },
  { keys: ['e'], label: 'Archive', group: 'Act' },
  { keys: ['#'], label: 'Move to trash', group: 'Act' },
  { keys: ['z'], label: 'Undo last action', group: 'Act' },

  { keys: ['i'], label: 'Original colours / fit to dark', group: 'Act' },
  { keys: ['p'], label: 'Print this message', group: 'Act' },
  { keys: ['⌘', 'P'], label: 'Print this message', group: 'Act' },

  { keys: ['c'], label: 'Compose', group: 'Write' },
  { keys: ['r'], label: 'Reply', group: 'Write' },
  { keys: ['a'], label: 'Reply all', group: 'Write' },
  { keys: ['f'], label: 'Forward', group: 'Write' },
  { keys: ['⌘', '↵'], label: 'Send', group: 'Write' },

  { keys: [','], label: 'Settings', group: 'App' },
  { keys: ['?'], label: 'Help and guides', group: 'App' },
];
