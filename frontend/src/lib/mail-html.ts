/**
 * Mail markup, prepared for a destination that is not this app.
 *
 * The reader mounts a message inside a shadow root; the print path writes the
 * same message into its own document. Both need the identical treatment
 * beforehand — the same strip, the same linkification, the same rule about
 * remote images — and there must be exactly one implementation of it, because
 * the moment there are two, one of them is the one with the hole in it.
 *
 * Security posture, in order:
 *  1. The backend sanitises on ingest (allow-list, no script/style/object/form,
 *     no event handlers, no javascript: URIs). That is the real defence.
 *  2. Callers isolate the result — a shadow root, or a separate document — so
 *     mail markup can never inherit or leak app styles.
 *  3. This second, cheap strip runs anyway. Defence in depth costs ~1ms.
 */

const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|form|link|meta|base|style)\b[^>]*>/gi;
const EVENT_ATTRS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URI = /(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;
const REMOTE_IMG = /<img([^>]*?)\ssrc=(["'])(https?:\/\/[^"']*)\2/gi;

const URL = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const LINKIFY_SKIP = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

/**
 * Strip what must never run, and defer remote images.
 *
 * Remote images become `data-src` and stay inert until the reader asks,
 * because loading them silently tells every sender exactly when a message was
 * opened — and a print job is not consent either, which is why the print path
 * passes the reader's own answer through rather than deciding for itself.
 */
export function sanitiseBody(html: string): string {
  return html
    .replace(BLOCKED_TAGS, '')
    .replace(EVENT_ATTRS, '')
    .replace(JS_URI, '$1="#"')
    .replace(REMOTE_IMG, '<img$1 data-src=$2$3$2');
}

/** Restore the deferred remote images, once the reader has said yes. */
export function loadDeferredImages(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-src]')) {
    img.src = img.dataset.src!;
    delete img.dataset.src;
  }
}

/** Drop the deferred remote images entirely. The reader can show a dashed
 *  placeholder and a "load them" button; a sheet of paper cannot. */
export function dropDeferredImages(root: ParentNode): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-src]')) img.remove();
}

/** Turn prose URLs into safe external links without reparsing the message. */
export function linkifyInDom(root: ParentNode): void {
  const doc = (root as Element).ownerDocument ?? document;
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = node.parentElement;
      if (!parent || LINKIFY_SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.match(URL)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text);

  for (const node of targets) {
    const value = node.nodeValue ?? '';
    URL.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let at = 0;

    for (let match = URL.exec(value); match; match = URL.exec(value)) {
      const raw = match[0];
      const url = raw.replace(URL_TRAILING_PUNCTUATION, '');
      if (!url) continue;

      if (match.index > at) fragment.append(doc.createTextNode(value.slice(at, match.index)));
      const link = doc.createElement('a');
      link.href = url.startsWith('www.') ? `https://${url}` : url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      link.textContent = url;
      fragment.append(link);
      at = match.index + url.length;
    }

    if (at === 0) continue;
    if (at < value.length) fragment.append(doc.createTextNode(value.slice(at)));
    node.replaceWith(fragment);
  }
}

/** Every link in a message opens externally, and never with a window.opener
 *  handle back to the app. */
export function hardenLinks(root: ParentNode): void {
  for (const a of root.querySelectorAll('a')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  }
}

/** For attributes and text interpolated into a document we build ourselves. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
