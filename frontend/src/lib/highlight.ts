/**
 * Marking search terms in text.
 *
 * Two consumers with very different constraints: list rows, which are React and
 * can be given elements; and the reader body, which is sanitised HTML inside a
 * shadow root and must not be reparsed.
 *
 * The shadow-root path is why this is DOM manipulation rather than string
 * surgery. Rebuilding the body's `innerHTML` with `<mark>` inserted would mean
 * sending sanitised output back through the parser with new markup spliced into
 * it — the exact operation the sanitiser exists to make unnecessary. Walking
 * text nodes and splitting them cannot introduce an element the sanitiser did
 * not already allow, because it never touches markup at all.
 */

/** Where a term matched. Offsets are into the original string. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Every span of `text` matched by any term, merged and ordered.
 *
 * Case-insensitive and literal — terms come from a search box, so a term
 * containing `(` is a paren the user typed, not a group they opened.
 */
export function findSpans(text: string, terms: string[]): Span[] {
  if (!text || !terms.length) return [];
  const haystack = text.toLowerCase();
  const spans: Span[] = [];

  for (const term of terms) {
    const needle = term.toLowerCase();
    if (needle.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }

  if (spans.length < 2) return spans;
  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  // Overlapping terms ("invoice" and "voice") would otherwise produce nested
  // marks, which render as double-highlighted and read as a bug.
  const merged: Span[] = [spans[0]!];
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push(s);
  }
  return merged;
}

/** `text` split into alternating plain and matched runs, for React to render. */
export function splitOnTerms(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const spans = findSpans(text, terms);
  if (!spans.length) return [{ text, hit: false }];

  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) parts.push({ text: text.slice(at, s.start), hit: false });
    parts.push({ text: text.slice(s.start, s.end), hit: true });
    at = s.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** Elements whose text is not prose and must never be rewritten. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'MARK']);

/**
 * Wrap every match inside `root` in `<mark class="hit">`, in place.
 *
 * Collects the text nodes first, then edits: a TreeWalker that mutates as it
 * walks will walk into the nodes it just created.
 */
export function markInDom(root: ParentNode, terms: string[]): void {
  if (!terms.length) return;

  const doc = (root as Element).ownerDocument ?? document;
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

  for (const node of targets) {
    const value = node.nodeValue ?? '';
    const spans = findSpans(value, terms);
    if (!spans.length) continue;

    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const s of spans) {
      if (s.start > at) frag.append(doc.createTextNode(value.slice(at, s.start)));
      const mark = doc.createElement('mark');
      mark.className = 'hit';
      mark.textContent = value.slice(s.start, s.end);
      frag.append(mark);
      at = s.end;
    }
    if (at < value.length) frag.append(doc.createTextNode(value.slice(at)));
    node.replaceWith(frag);
  }
}
