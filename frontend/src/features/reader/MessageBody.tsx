/**
 * Renders an HTML mail body.
 *
 * Security posture, in order:
 *  1. The backend sanitises on ingest (allow-list, no script/style/object/form,
 *     no event handlers, no javascript: URIs). That is the real defence.
 *  2. This component mounts the result inside a **shadow root**, so the mail's
 *     markup can never inherit or leak app styles — the classic reason webmail
 *     bodies wreck the surrounding UI.
 *  3. A second, cheap strip runs here anyway. Defence in depth costs ~1ms.
 *
 * Remote images are rewritten to `data-src` and only restored when the user
 * asks, because loading them silently tells every sender exactly when a message
 * was opened.
 */

import { useEffect, useRef } from 'react';
import { markInDom } from '@/lib/highlight';

/** Stable empty default, so an unmarked body does not re-run the effect on
 *  every render. */
const EMPTY_TERMS: string[] = [];

const BLOCKED_TAGS = /<\/?(script|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi;
const EVENT_ATTRS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URI = /(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;
const URL = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const LINKIFY_SKIP = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

/** Turn prose URLs into safe external links without reparsing the message. */
function linkifyInDom(root: ParentNode): void {
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

/** Styles applied *inside* the shadow root. The mail's own CSS still wins for
 *  its own elements; this only sets a sane baseline. */
const SHADOW_CSS = `
  :host { display: block; }
  * { max-width: 100%; }
  body, div, p, td, span, li { font-family: inherit; }
  p { margin: 0 0 1em; }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  img { height: auto; border-radius: 2px; }
  img[data-src] {
    min-height: 24px;
    border: 1px dashed var(--line-strong);
    background: var(--bg-sunken);
  }
  blockquote {
    margin: 1em 0;
    padding-left: 1em;
    border-left: 2px solid var(--line);
    color: var(--text-muted);
  }
  pre, code { font-family: var(--font-mono); font-size: 0.92em; }
  pre { overflow-x: auto; padding: 12px; background: var(--bg-sunken); border-radius: 4px; }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { padding: 4px 8px; }
  hr { border: none; border-top: 1px solid var(--line); margin: 1.5em 0; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; font-weight: 500; }
  /* Search hits. Declared again in here because a shadow root does not inherit
     stylesheets — only custom properties cross the boundary, which is exactly
     why the tokens still resolve. Without this the browser's default yellow
     wins and the reader stops matching the list. */
  mark.hit {
    background: var(--accent-soft);
    color: inherit;
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 1px var(--accent-line);
    padding: 0 1px;
  }
`;

export function MessageBody({
  html,
  text,
  loadRemote,
  terms = EMPTY_TERMS,
}: {
  html: string | null;
  text: string | null;
  loadRemote: boolean;
  /** Search terms to mark. Marking happens on the parsed DOM inside the shadow
   *  root, never by splicing markup back into the sanitised string. */
  terms?: string[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);

  useEffect(() => {
    if (html === null) {
      const textHost = textRef.current;
      if (!textHost) return;
      textHost.textContent = text ?? '';
      linkifyInDom(textHost);
      markInDom(textHost, terms);
      return;
    }

    const host = hostRef.current;
    if (!host) return;

    if (shadowRef.current?.host !== host) shadowRef.current = host.attachShadow({ mode: 'open' });
    const root = shadowRef.current;

    const clean = html
      .replace(BLOCKED_TAGS, '')
      .replace(EVENT_ATTRS, '')
      .replace(JS_URI, '$1="#"')
      // Defer remote images until the user opts in.
      .replace(/<img([^>]*?)\ssrc=(["'])(https?:\/\/[^"']*)\2/gi, '<img$1 data-src=$2$3$2');

    root.innerHTML = `<style>${SHADOW_CSS}</style><div>${clean}</div>`;

    // Also make plaintext URLs links. Existing and generated links open
    // externally, never with a window.opener handle.
    linkifyInDom(root);
    for (const a of root.querySelectorAll('a')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    }

    if (loadRemote) {
      for (const img of root.querySelectorAll<HTMLImageElement>('img[data-src]')) {
        img.src = img.dataset.src!;
        delete img.dataset.src;
      }
    }

    // After sanitising and after the DOM exists — marking edits text nodes in
    // place, so it can only ever produce `<mark>` elements this code created.
    markInDom(root, terms);
  }, [html, loadRemote, terms, text]);

  if (html === null) {
    return (
      <div ref={textRef} className="reader__text" />
    );
  }

  return (
    <div className="reader__body__scroll">
      <div ref={hostRef} />
    </div>
  );
}
