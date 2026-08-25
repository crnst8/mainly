/**
 * Glyphs: the pickable icon set.
 *
 * Separate from `icons.tsx`, which is the interface's own vocabulary — Archive
 * means archive there, and adding a cactus to it would mean the set no longer
 * describes the product. This set is the opposite kind of thing: forty marks
 * with no assigned meaning, offered so a mailbox can be labelled by the thing it
 * is *for*. "Invoices" is faster to find as a receipt than as the letters IN.
 *
 * Same drawing rules as `icons.tsx` — 16px grid, 1.5 stroke, currentColor, no
 * fills — because they sit two centimetres apart in the rail and a set that
 * drifted in weight would read as two products stitched together.
 *
 * Ids are stable strings, stored in preferences. Renaming one orphans every
 * mailbox wearing it, so they are append-only in practice: add, never rename.
 */

import type { SVGProps } from 'react';

export type GlyphCategory = 'work' | 'people' | 'things' | 'nature' | 'marks';

export interface GlyphDef {
  id: string;
  /** Spoken name — the accessible label, and what the search box matches. */
  label: string;
  category: GlyphCategory;
  /** Path data on the shared 16px grid. */
  d: string;
  /** Extra circles, for the handful of marks a single path cannot draw well. */
  circles?: { cx: number; cy: number; r: number }[];
}

export const GLYPH_CATEGORIES: { id: GlyphCategory; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'people', label: 'People' },
  { id: 'things', label: 'Things' },
  { id: 'nature', label: 'Nature' },
  { id: 'marks', label: 'Marks' },
];

export const GLYPHS: GlyphDef[] = [
  /* ── Work ───────────────────────────────────────────────────────────────── */
  {
    id: 'briefcase',
    label: 'Briefcase',
    category: 'work',
    d: 'M2 6.2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM6 5.2V3.6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.6M2 8.8h12',
  },
  {
    id: 'building',
    label: 'Building',
    category: 'work',
    d: 'M3 13.5v-10a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v10M11 6.5h2a1 1 0 0 1 1 1v6M5.5 5h1M8.5 5h1M5.5 8h1M8.5 8h1M6.6 13.5v-2.4h2.8v2.4M1.6 13.5h12.8',
  },
  {
    id: 'invoice',
    label: 'Invoice',
    category: 'work',
    d: 'M3.5 2.5h9v11l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1zM6 5.8h4M6 8.4h4',
  },
  {
    id: 'chart',
    label: 'Chart',
    category: 'work',
    d: 'M2.5 13.5h11M4.5 13.5V9M7.5 13.5V4.5M10.5 13.5V7M13 13.5v-3',
  },
  {
    id: 'trend',
    label: 'Trend',
    category: 'work',
    d: 'M2.5 11.5 6 7.8l2.4 2.2L13.5 4.5M13.5 4.5H10M13.5 4.5V8',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    category: 'work',
    d: 'M2.5 4.6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM2.5 7h11M5.5 2.4v2.4M10.5 2.4v2.4',
  },
  {
    id: 'clipboard',
    label: 'Clipboard',
    category: 'work',
    d: 'M6 3.4H4.5a1 1 0 0 0-1 1v8.1a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.4a1 1 0 0 0-1-1H10M6 3.4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1H6zM6 8.2h4M6 10.6h2.6',
  },
  {
    id: 'server',
    label: 'Server',
    category: 'work',
    d: 'M2.5 3.6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v2.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM2.5 10.2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v2.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM4.8 4.7h.01M4.8 11.3h.01',
  },
  {
    id: 'code',
    label: 'Code',
    category: 'work',
    d: 'M5.6 5 2.4 8l3.2 3M10.4 5l3.2 3-3.2 3M9.2 3.4 6.8 12.6',
  },
  {
    id: 'link',
    label: 'Link',
    category: 'work',
    d: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9',
  },

  /* ── People ─────────────────────────────────────────────────────────────── */
  {
    id: 'person',
    label: 'Person',
    category: 'people',
    d: 'M3 13.4v-.8a3.4 3.4 0 0 1 3.4-3.4h3.2A3.4 3.4 0 0 1 13 12.6v.8',
    circles: [{ cx: 8, cy: 5.2, r: 2.6 }],
  },
  {
    id: 'people',
    label: 'People',
    category: 'people',
    d: 'M1.8 13.2v-.6a2.8 2.8 0 0 1 2.8-2.8h2.2a2.8 2.8 0 0 1 2.8 2.8v.6M10.6 9.9h1a2.8 2.8 0 0 1 2.8 2.8v.5M10.2 3.2a2.2 2.2 0 0 1 0 4.3',
    circles: [{ cx: 5.7, cy: 5.3, r: 2.2 }],
  },
  {
    id: 'chat',
    label: 'Chat',
    category: 'people',
    d: 'M13.5 8.6c0 2.5-2.5 4.5-5.5 4.5-.8 0-1.6-.15-2.3-.4L2.5 13.6l.9-2.5A4.3 4.3 0 0 1 2.5 8.6c0-2.5 2.5-4.5 5.5-4.5s5.5 2 5.5 4.5z',
  },
  {
    id: 'smile',
    label: 'Smile',
    category: 'people',
    d: 'M5.4 9.4a3.2 3.2 0 0 0 5.2 0M6 6.4h.01M10 6.4h.01',
    circles: [{ cx: 8, cy: 8, r: 5.8 }],
  },
  {
    id: 'globe',
    label: 'Globe',
    category: 'people',
    d: 'M2.2 8h11.6M8 2.2c1.7 1.8 2.6 3.9 2.6 5.8S9.7 12 8 13.8C6.3 12 5.4 9.9 5.4 8s.9-4 2.6-5.8z',
    circles: [{ cx: 8, cy: 8, r: 5.8 }],
  },
  {
    id: 'heart',
    label: 'Heart',
    category: 'people',
    d: 'M8 13.2 3.1 8.5a3 3 0 1 1 4.9-3.4 3 3 0 1 1 4.9 3.4z',
  },
  {
    id: 'home',
    label: 'Home',
    category: 'people',
    d: 'M2.4 7.4 8 2.6l5.6 4.8M4 8.7v4.1a.8.8 0 0 0 .8.8h6.4a.8.8 0 0 0 .8-.8V8.7M6.6 13.6V9.9h2.8v3.7',
  },

  /* ── Things ─────────────────────────────────────────────────────────────── */
  {
    id: 'box',
    label: 'Box',
    category: 'things',
    d: 'M2.4 5.4 8 2.6l5.6 2.8-5.6 2.8zM2.4 5.4v5.2L8 13.4l5.6-2.8V5.4M8 8.2v5.2',
  },
  {
    id: 'truck',
    label: 'Truck',
    category: 'things',
    d: 'M1.6 4.6a.8.8 0 0 1 .8-.8h5.9a.8.8 0 0 1 .8.8v6.2H1.6zM9.1 6.6h2.4l2.9 2.6v1.6H9.1M4.4 12.4a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0zM13.4 12.4a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0z',
  },
  {
    id: 'tag',
    label: 'Tag',
    category: 'things',
    d: 'M2.6 7.9V3.4a.8.8 0 0 1 .8-.8h4.5l5.5 5.5a1 1 0 0 1 0 1.4l-3.6 3.6a1 1 0 0 1-1.4 0zM5.5 5.5h.01',
  },
  {
    id: 'card',
    label: 'Card',
    category: 'things',
    d: 'M1.8 5a1 1 0 0 1 1-1h10.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1zM1.8 6.9h12.4M4 9.8h2.4',
  },
  {
    id: 'coin',
    label: 'Coin',
    category: 'things',
    d: 'M8 4.6v6.8M9.8 6.1a2 2 0 0 0-1.8-.9c-1 0-1.8.6-1.8 1.4S7 8 8 8s1.8.6 1.8 1.4-.8 1.4-1.8 1.4a2 2 0 0 1-1.8-.9',
    circles: [{ cx: 8, cy: 8, r: 5.8 }],
  },
  {
    id: 'camera',
    label: 'Camera',
    category: 'things',
    d: 'M1.8 6a1 1 0 0 1 1-1h1.6l1-1.6h5.2l1 1.6h1.6a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z',
    circles: [{ cx: 8, cy: 8.6, r: 2.4 }],
  },
  {
    id: 'music',
    label: 'Music',
    category: 'things',
    d: 'M5.8 11.4V3.8l7-1.4v7.6',
    circles: [
      { cx: 4.2, cy: 11.6, r: 1.7 },
      { cx: 11.2, cy: 10.2, r: 1.7 },
    ],
  },
  {
    id: 'book',
    label: 'Book',
    category: 'things',
    d: 'M2.6 3.4a.8.8 0 0 1 .8-.8h3.2a1.4 1.4 0 0 1 1.4 1.4v9a1.2 1.2 0 0 0-1.2-1.2H2.6zM13.4 3.4a.8.8 0 0 0-.8-.8H9.4A1.4 1.4 0 0 0 8 4v9a1.2 1.2 0 0 1 1.2-1.2h4.2z',
  },
  {
    id: 'flask',
    label: 'Flask',
    category: 'things',
    d: 'M6.4 2.5v4L2.9 11.9a1 1 0 0 0 .84 1.6h8.52a1 1 0 0 0 .84-1.6L9.6 6.5v-4M5.4 2.5h5.2M4.6 9.6h6.8',
  },
  {
    id: 'rocket',
    label: 'Rocket',
    category: 'things',
    d: 'M8 1.9c2 1.6 3.1 3.9 3.1 6.4l-.9 2.4H5.8l-.9-2.4c0-2.5 1.1-4.8 3.1-6.4zM5.4 8.2 3.2 9.8l.5 2.6 2-1.4M10.6 8.2l2.2 1.6-.5 2.6-2-1.4M6.6 13.9c.9-.6 1.9-.6 2.8 0',
    circles: [{ cx: 8, cy: 6.3, r: 1.3 }],
  },
  {
    id: 'shield',
    label: 'Shield',
    category: 'things',
    d: 'M8 2.1 3 4.2v4c0 2.6 2 4.8 5 5.7 3-.9 5-3.1 5-5.7v-4zM5.9 8.1l1.5 1.5 2.8-2.8',
  },
  {
    id: 'bell',
    label: 'Bell',
    category: 'things',
    d: 'M4.2 11h7.6l-1-1.6V7.2a2.8 2.8 0 0 0-5.6 0v2.2zM6.7 12.6a1.4 1.4 0 0 0 2.6 0M8 4.4V2.8',
  },
  {
    id: 'bolt',
    label: 'Bolt',
    category: 'things',
    d: 'M8.9 1.8 3.6 8.9h3.7l-.2 5.3 5.3-7.1H8.7z',
  },
  {
    id: 'key',
    label: 'Key',
    category: 'things',
    d: 'm7.9 8.1 5.8-5.8M11.3 4.7l1.6 1.6M9.7 6.3l1.6 1.6',
    circles: [{ cx: 5.5, cy: 10.5, r: 3.4 }],
  },
  {
    id: 'lock',
    label: 'Lock',
    category: 'things',
    d: 'M3.6 7.4a1 1 0 0 1 1-1h6.8a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1zM5.6 6.4V5a2.4 2.4 0 0 1 4.8 0v1.4M8 9.3v1.6',
  },
  {
    id: 'cup',
    label: 'Cup',
    category: 'things',
    d: 'M2.8 4.6h8.4v4.6a3.4 3.4 0 0 1-3.4 3.4H6.2a3.4 3.4 0 0 1-3.4-3.4zM11.2 5.8h1a1.8 1.8 0 0 1 0 3.6h-1M3.4 13.8h8',
  },
  {
    id: 'plane',
    label: 'Plane',
    category: 'things',
    d: 'M9.1 2.6a1.1 1.1 0 0 0-2.2 0v3.1L1.8 8.9v1.6l5.1-1.5v2.6l-1.6 1.2v1l2.7-.8 2.7.8v-1l-1.6-1.2V9l5.1 1.5V8.9L9.1 5.7z',
  },

  /* ── Nature ─────────────────────────────────────────────────────────────── */
  {
    id: 'leaf',
    label: 'Leaf',
    category: 'nature',
    d: 'M2.6 13.4c-1.4-4 .6-8.2 4.6-9.6 1.7-.6 3.6-.5 5.4.2.5 4.6-2 8.4-6 9-1.2.2-2.5.1-4-.6zM6.2 9.8c1.4-1.6 3.2-2.8 5.2-3.5',
  },
  {
    id: 'tree',
    label: 'Tree',
    category: 'nature',
    d: 'M8 1.9 3.8 7.3h2.1L3 11.3h10L10.1 7.3h2.1zM8 11.3v2.8M6.2 14.1h3.6',
  },
  {
    id: 'sun',
    label: 'Sun',
    category: 'nature',
    d: 'M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6',
    circles: [{ cx: 8, cy: 8, r: 3.1 }],
  },
  {
    id: 'moon',
    label: 'Moon',
    category: 'nature',
    d: 'M13.2 9.6A5.7 5.7 0 0 1 6.4 2.8a5.7 5.7 0 1 0 6.8 6.8z',
  },
  {
    id: 'cloud',
    label: 'Cloud',
    category: 'nature',
    d: 'M4.6 12.2a3 3 0 0 1-.3-6 4 4 0 0 1 7.5.9 2.6 2.6 0 0 1-.5 5.1z',
  },
  {
    id: 'wave',
    label: 'Wave',
    category: 'nature',
    d: 'M1.8 5.4c1.6-1.6 3.1-1.6 4.7 0s3.1 1.6 4.7 0 3.1-1.6 3.1-1.6M1.8 9c1.6-1.6 3.1-1.6 4.7 0s3.1 1.6 4.7 0 3.1-1.6 3.1-1.6M1.8 12.6c1.6-1.6 3.1-1.6 4.7 0s3.1 1.6 4.7 0 3.1-1.6 3.1-1.6',
  },
  {
    id: 'flame',
    label: 'Flame',
    category: 'nature',
    d: 'M8 1.9c2.6 2.4 4.4 4.6 4.4 7A4.4 4.4 0 0 1 3.6 9c0-1.2.5-2.3 1.4-3.3.2 1 .8 1.7 1.6 2 .1-2.2.6-4 1.4-5.8zM8 13.3a2 2 0 0 1-2-2c0-.9.7-1.7 2-2.8 1.3 1.1 2 1.9 2 2.8a2 2 0 0 1-2 2z',
  },
  {
    id: 'paw',
    label: 'Paw',
    category: 'nature',
    d: 'M8 9.6c1.9 0 3.5 1.4 3.5 2.9a1.7 1.7 0 0 1-1.7 1.7c-.6 0-1.2-.2-1.8-.2s-1.2.2-1.8.2a1.7 1.7 0 0 1-1.7-1.7c0-1.5 1.6-2.9 3.5-2.9z',
    circles: [
      { cx: 3.6, cy: 6.6, r: 1.3 },
      { cx: 6.5, cy: 4.2, r: 1.3 },
      { cx: 9.5, cy: 4.2, r: 1.3 },
      { cx: 12.4, cy: 6.6, r: 1.3 },
    ],
  },

  /* ── Marks ──────────────────────────────────────────────────────────────── */
  {
    id: 'star',
    label: 'Star',
    category: 'marks',
    d: 'm8 2 1.85 3.9 4.15.6-3 3 .7 4.3L8 11.8 4.3 13.8l.7-4.3-3-3 4.15-.6z',
  },
  {
    id: 'flag',
    label: 'Flag',
    category: 'marks',
    d: 'M3.8 13.8V2.6M3.8 3.4h7.9l-1.6 2.9 1.6 2.9H3.8',
  },
  {
    id: 'pin',
    label: 'Pin',
    category: 'marks',
    d: 'M8 14V9.6M5.1 6.8V2.8h5.8v4l2 2.6H3.1z',
  },
  {
    id: 'target',
    label: 'Target',
    category: 'marks',
    d: '',
    circles: [
      { cx: 8, cy: 8, r: 5.8 },
      { cx: 8, cy: 8, r: 3.2 },
      { cx: 8, cy: 8, r: 0.9 },
    ],
  },
  {
    id: 'diamond',
    label: 'Diamond',
    category: 'marks',
    d: 'M8 1.9 14.1 8 8 14.1 1.9 8z',
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    category: 'marks',
    d: 'M8 1.9 13.6 5v6L8 14.1 2.4 11V5z',
  },
  {
    id: 'circle',
    label: 'Circle',
    category: 'marks',
    d: '',
    circles: [{ cx: 8, cy: 8, r: 5.8 }],
  },
  {
    id: 'square',
    label: 'Square',
    category: 'marks',
    d: 'M2.6 3.6a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z',
  },
  {
    id: 'triangle',
    label: 'Triangle',
    category: 'marks',
    d: 'M8 2.4 14.2 13.2H1.8z',
  },
  {
    id: 'asterisk',
    label: 'Asterisk',
    category: 'marks',
    d: 'M8 2.4v11.2M3.2 5.2l9.6 5.6M12.8 5.2l-9.6 5.6',
  },
];

const BY_ID = new Map(GLYPHS.map((g) => [g.id, g]));

export function glyphDef(id: string | null | undefined): GlyphDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Renders nothing for an id that no longer exists, so a stored glyph from a
 *  future version degrades to the monogram instead of throwing. */
export function Glyph({
  name,
  size = 16,
  ...rest
}: SVGProps<SVGSVGElement> & { name: string; size?: number }) {
  const def = BY_ID.get(name);
  if (!def) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {def.d && <path d={def.d} />}
      {def.circles?.map((c, i) => (
        <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
    </svg>
  );
}
