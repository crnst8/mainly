/**
 * Re-lighting a mail body.
 *
 * A message arrives carrying its sender's colours, and those colours assume a
 * context: almost always black ink on white paper. Two places break that
 * assumption, and they break it in opposite directions — a dark reader, where
 * a white mail is a floodlight, and a real printer, where a dark mail is a
 * cartridge. This is one transform serving both.
 *
 * The rule either way: keep the hue the sender chose, move the *lightness* into
 * the band the destination needs, and never touch what the sender left
 * transparent — transparent means "whatever is behind me", and behind it is a
 * surface we already own.
 *
 * The two modes differ in one line, and the difference is the whole design:
 *
 *   dark — remap. The sender's whole light range is rescaled onto a dark one,
 *          so the separation between a page and a card on it survives. A hard
 *          clamp would collapse #fff and #f4f4f4 onto the same grey and flatten
 *          every layout that uses tone instead of rules.
 *   ink  — clamp. Most mail is already black-on-white, and for that mail the
 *          clamp is a no-op: nothing is "converted", it is simply left alone.
 *          It only bites on the parts that would waste toner — a dark header
 *          bar, pale grey small print — and lifts exactly those.
 *
 * Nothing here parses CSS text of its own. Every colour is read back from
 * `getComputedStyle` after the browser has resolved it, which is the only way
 * to see through `bgcolor` attributes, `<font color>`, border shorthands and
 * inheritance — all four ordinary in mail markup, none of them findable by a
 * regex over the source.
 */

export type Relight = 'dark' | 'ink';

/**
 * What a message turned out to be, before anything was done about it.
 *
 * Two facts, and the second is the one that is easy to miss: a message can
 * decline to have a background at all. Most do. When it does, it is not
 * "white" — it is standing on whatever the reader put behind it, and its ink
 * was chosen against a surface that may be the opposite one.
 */
export interface Verdict {
  /** True when the message's own ink was written to sit on a dark surface. */
  inkForDark: boolean;
  /** True when the message paints enough background to stand on its own, and
   *  so cannot be caught out by whatever is behind it. */
  standsAlone: boolean;
}

type Role = 'bg' | 'text' | 'line';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Where each role's lightness may land, 0–1, in HSL.
 *
 * HSL rather than a perceptual space on purpose: its lightness axis is the one
 * that treats a saturated mid-tone as a mid-tone. A brand red at L 0.5 comes
 * through both modes still recognisably that red, which is the point — this is
 * a re-lighting, not a repaint.
 */
const BANDS: Record<Relight, Record<Role, [number, number]>> = {
  // The floor sits at the app's own dark surface, so a white mail body lands
  // level with the reader around it instead of inside a black box.
  dark: { bg: [0.1, 0.44], text: [0.66, 0.96], line: [0.22, 0.52] },
  ink: { bg: [0.84, 1], text: [0, 0.34], line: [0.2, 0.7] },
};

/** Chroma is context too: the saturated fill that reads as a highlight on a
 *  screen reads as spent toner on paper, and as mud on a dark surface. */
const CHROMA: Record<Relight, Record<Role, number>> = {
  dark: { bg: 0.7, text: 0.82, line: 0.7 },
  ink: { bg: 0.2, text: 0.4, line: 0.3 },
};

/**
 * Roles where landing outside the band means the sender reversed it out.
 *
 * White heading text on a dark band is the *most* emphatic ink in a message.
 * Clamping it lands it on the band's ceiling — 34% grey, the *least* emphatic
 * ink there is — which quietly turns the loudest line on a receipt into the
 * faintest. Mirroring it first sends white to black, which is what it meant.
 *
 * Borders are excluded, and that is not an oversight: a hairline is structure,
 * not emphasis. Mirroring a #eceef1 rule would print it at 20% — a heavy black
 * line where the sender drew the lightest one they could.
 */
const REFLECT: Record<Role, boolean> = { bg: false, text: true, line: false };

/** Below this, a background is the mail's idea of "dark". */
const DARK_SURFACE = 0.42;
/** Above this, text is light enough to imply a dark surface behind it. */
const LIGHT_INK = 0.6;
/** Backgrounds must cover this much of the body before they outvote the text. */
const BACKGROUND_QUORUM = 0.35;

/**
 * And this much before the message is standing on its own rather than on ours.
 *
 * Higher than the quorum, because the two ask different questions: "enough
 * background to judge the sender's intent by" is a weaker claim than "enough
 * background that what is behind it cannot matter". Nested backgrounds are
 * counted twice — an outer table inside an inner card — so the total runs high,
 * which errs toward leaving a message alone. That is the safe direction: a card
 * nobody needed is a worse outcome than no card, because no card only shows at
 * all in the case this is meant to catch.
 */
const OPAQUE_ENOUGH = 0.6;

/**
 * Elements past this are left alone.
 *
 * Two reads and up to nine writes each is nothing at a thousand elements and
 * a visible stall at fifty thousand, and mail that large is a generated report
 * whose colours were never the point. Doing nothing is a correct outcome here:
 * the body still renders, it just renders as sent.
 */
const MAX_ELEMENTS = 8000;

const SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'TITLE', 'HEAD']);

/* ── Colour ─────────────────────────────────────────────────────────────────
   Computed colours are nearly always `rgb()` / `rgba()`, so that path is a
   regex. Everything else — `oklch()`, `color(display-p3 …)`, `lab()`, whatever
   ships next — goes through a 1×1 canvas, which resolves any colour the
   browser can parse into bytes without this file knowing the space exists. */

const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i;

const parsed = new Map<string, Rgba | null>();
let probe: CanvasRenderingContext2D | null | undefined;

function parseColor(value: string): Rgba | null {
  const cached = parsed.get(value);
  if (cached !== undefined) return cached;
  const out = readColor(value);
  // Mail reuses a handful of colours across thousands of nodes; the cache turns
  // a per-element cost into a per-palette one.
  parsed.set(value, out);
  return out;
}

function readColor(value: string): Rgba | null {
  const v = value.trim();
  if (!v || v === 'transparent' || v === 'none') return null;

  const m = RGB_FN.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number.isFinite(alpha) ? alpha : 1 };
  }

  if (probe === undefined) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  }
  if (!probe) return null;
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = v;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  } catch {
    return null;
  }
}

function toHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number, a: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h * 6) % 6;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[seg < 0 ? seg + 6 : seg]!;
  const to = (n: number) => Math.round((n + m) * 255);
  return a >= 1 ? `rgb(${to(r)}, ${to(g)}, ${to(b)})` : `rgba(${to(r)}, ${to(g)}, ${to(b)}, ${round(a)})`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The whole transform. Everything else in this file is either reading colours
 *  out of the DOM or deciding whether to call this. */
function shift(color: Rgba, mode: Relight, role: Role, invert: boolean): string {
  const { h, s, l } = toHsl(color);
  const v = invert ? 1 - l : l;
  const [lo, hi] = BANDS[mode][role];
  const out = mode === 'dark' ? lo + v * (hi - lo) : fit(v, lo, hi, REFLECT[role]);
  return fromHsl(h, Math.min(1, s * CHROMA[mode][role]), out, color.a);
}

/** Inside the band, nothing happens — the no-op that makes ink mode faithful
 *  to a receipt that was already black on white. Outside it, mirror where
 *  emphasis has to survive the trip, then clamp either way. */
function fit(l: number, lo: number, hi: number, reflect: boolean): number {
  if (l >= lo && l <= hi) return l;
  return Math.min(Math.max(reflect ? 1 - l : l, lo), hi);
}

/* ── Reading the body ─────────────────────────────────────────────────────── */

interface Read {
  el: HTMLElement;
  bg: Rgba | null;
  /** Set only where the element has a background image, which we never fight. */
  hasImage: boolean;
  color: Rgba | null;
  borders: [side: string, color: Rgba][];
  area: number;
  hasText: boolean;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Read every element once, before anything is written.
 *
 * Strictly two-phase, and it has to be: writing an inline style invalidates
 * style, so a read/write/read/write loop pays a full recalculation per element.
 * Read everything, decide, then write everything.
 */
function survey(root: ParentNode): Read[] {
  const out: Read[] = [];
  const all = root.querySelectorAll<HTMLElement>('*');
  const limit = Math.min(all.length, MAX_ELEMENTS);

  for (let i = 0; i < limit; i++) {
    const el = all[i]!;
    if (SKIP_TAGS.has(el.tagName)) continue;
    const cs = getComputedStyle(el);

    const borders: [string, Rgba][] = [];
    for (const side of SIDES) {
      if (Number.parseFloat(cs.getPropertyValue(`border-${side}-width`)) <= 0) continue;
      const c = parseColor(cs.getPropertyValue(`border-${side}-color`));
      if (c && c.a > 0) borders.push([side, c]);
    }

    let hasText = false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) {
        hasText = true;
        break;
      }
    }

    const bg = parseColor(cs.backgroundColor);
    out.push({
      el,
      bg: bg && bg.a > 0 ? bg : null,
      hasImage: cs.backgroundImage !== 'none',
      color: parseColor(cs.color),
      borders,
      area: el.offsetWidth * el.offsetHeight,
      hasText,
    });
  }
  return out;
}

/**
 * Which way round the sender meant it.
 *
 * Backgrounds decide it when there are enough of them to constitute a page.
 * Otherwise the ink does — and this is the case that matters most, because the
 * single most common broken mail is the one that declares no background at all
 * and hardcodes `color: #333`. It inherits the reader's dark surface and then
 * paints dark grey on it. Nothing about its *backgrounds* says "light"; the
 * text is the only evidence, and it is conclusive.
 */
function judge(reads: Read[], rootArea: number): Verdict {
  let covered = 0;
  let weighted = 0;
  let inkCount = 0;
  let inkSum = 0;

  for (const r of reads) {
    if (r.bg && r.bg.a >= 0.6 && r.area > 0) {
      covered += r.area;
      weighted += r.area * toHsl(r.bg).l;
    }
    if (r.hasText && r.color && r.color.a >= 0.5) {
      inkCount++;
      inkSum += toHsl(r.color).l;
    }
  }

  const area = Math.max(1, rootArea);
  const standsAlone = covered > area * OPAQUE_ENOUGH;

  if (covered > area * BACKGROUND_QUORUM) {
    return { inkForDark: weighted / covered < DARK_SURFACE, standsAlone };
  }
  if (inkCount) return { inkForDark: inkSum / inkCount > LIGHT_INK, standsAlone };
  // No signal at all — an empty body, or one made entirely of images. Light is
  // the overwhelming default and the safe guess: it leaves ink mode a no-op and
  // asks for no surface that was not already there.
  return { inkForDark: false, standsAlone };
}

/**
 * The verdict on its own, changing nothing.
 *
 * A light reader has no re-lighting to do — mail is drawn for a light page and
 * already suits one — but it still has to know when a message brought no
 * surface of its own, because that is the one case where a light page is the
 * wrong thing to be standing on. So this pays the same survey cost the
 * re-lighting modes pay, for an answer that is usually "nothing to do".
 */
export function readIntent(root: ParentNode): Verdict {
  const reads = survey(root);
  if (!reads.length) return { inkForDark: false, standsAlone: false };
  return judge(reads, referenceArea(root, reads));
}

/** The reference area is the container itself where there is one — a shadow
 *  root has no box of its own, so its first child element stands in for it. */
function referenceArea(root: ParentNode, reads: Read[]): number {
  const frame = root instanceof HTMLElement ? root : reads[0]!.el;
  return frame.offsetWidth * frame.offsetHeight;
}

/* ── Applying ─────────────────────────────────────────────────────────────── */

/**
 * Re-light everything under `root` for `mode`.
 *
 * Idempotent in practice because both callers rebuild the subtree from the
 * sanitised source before calling — there is no "undo", there is a re-render.
 * Returns what the message turned out to be, which the caller still needs: a
 * body that brought no background of its own may want a surface as well as a
 * re-lighting.
 */
export function relight(root: ParentNode, mode: Relight): Verdict {
  const reads = survey(root);
  if (!reads.length) return { inkForDark: false, standsAlone: false };

  const verdict = judge(reads, referenceArea(root, reads));
  const invert = verdict.inkForDark !== (mode === 'dark');

  for (const r of reads) {
    // A background image is the element's whole appearance — a hero, a
    // gradient, a logo sprite. Re-lighting the colour underneath it produces a
    // seam and fixes nothing, so the element keeps what the sender gave it.
    if (r.bg && !r.hasImage) {
      r.el.style.setProperty('background-color', shift(r.bg, mode, 'bg', invert), 'important');
    }
    if (r.color && r.color.a > 0) {
      r.el.style.setProperty('color', shift(r.color, mode, 'text', invert), 'important');
    }
    for (const [side, c] of r.borders) {
      r.el.style.setProperty(`border-${side}-color`, shift(c, mode, 'line', invert), 'important');
    }
  }

  return verdict;
}
