/**
 * Renders an HTML mail body.
 *
 * The markup is prepared by `lib/mail-html` — one sanitiser, shared with the
 * print path — and then mounted inside a **shadow root**, so the mail's own
 * CSS can never inherit or leak app styles. That isolation is the classic
 * reason webmail bodies wreck the surrounding UI, and it is also what makes
 * `relight` safe: everything it rewrites is inside a boundary nothing else
 * reads across.
 *
 * `relight` is the dark-mode pass. A message was drawn for white paper; on a
 * dark surface it arrives as a floodlight, or — worse and far more common —
 * as a body that declares no background at all and hardcodes `color: #333`,
 * which lands dark grey on dark grey and cannot be read. Re-lighting it is not
 * a preference for its own sake; without it half of dark mode is broken.
 */

import { useEffect, useRef } from 'react';
import { markInDom } from '@/lib/highlight';
import { hardenLinks, linkifyInDom, loadDeferredImages, sanitiseBody } from '@/lib/mail-html';
import { readIntent, relight } from '@/lib/relight';

/** Stable empty default, so an unmarked body does not re-run the effect on
 *  every render. */
const EMPTY_TERMS: string[] = [];

/** Styles applied *inside* the shadow root. The mail's own CSS still wins for
 *  its own elements; this only sets a sane baseline. */
const SHADOW_CSS = `
  /* The app turns synthetic weights off so its own one-file mono face is never
     smeared. A message is not ours to make that call about: whatever the sender
     asked for in a <b>, the browser gets to draw it. */
  :host { display: block; font-synthesis-weight: auto; }
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
  pre, code { font-family: var(--font-mono); font-size: 0.92em; font-synthesis-weight: none; }
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
  relit = false,
  surface = 'light',
  terms = EMPTY_TERMS,
}: {
  html: string | null;
  text: string | null;
  loadRemote: boolean;
  /** Re-light the sender's colours for a dark surface. There is no "undo"
   *  path: changing this rebuilds the subtree from the sanitised source, so
   *  the original is always one render away. */
  relit?: boolean;
  /**
   * What the message is being put down on.
   *
   * Separate from `relit`, because they are separate facts and the interesting
   * cases are the ones where they disagree — a message shown as sent on a dark
   * reader, or re-lit for dark while the app is light. Either way the surface
   * is what decides whether the body can be left standing on the page.
   */
  surface?: 'light' | 'dark';
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

    root.innerHTML = `<style>${SHADOW_CSS}</style><div>${sanitiseBody(html)}</div>`;

    // Also make plaintext URLs links. Existing and generated links open
    // externally, never with a window.opener handle.
    linkifyInDom(root);
    hardenLinks(root);

    if (loadRemote) loadDeferredImages(root);

    // After the images are restored, so this sees the tree it will actually be
    // looking at rather than a set of empty placeholders.
    const verdict = relit ? relight(root, 'dark') : readIntent(root);

    /*
     * Does the body need a surface of its own?
     *
     * Only when it brought none — a message that paints its own background
     * cannot be caught out by what is behind it. Re-lighting settles the
     * question the other way: it has just moved the sender's ink to suit a dark
     * surface, so a dark surface is what it now wants, whatever it wanted
     * before.
     */
    const wants = relit ? true : verdict.inkForDark;
    const borrowed = !verdict.standsAlone && wants !== (surface === 'dark');
    if (borrowed) host.dataset.surface = wants ? 'dark' : 'light';
    else delete host.dataset.surface;

    // After sanitising and after the DOM exists — marking edits text nodes in
    // place, so it can only ever produce `<mark>` elements this code created.
    markInDom(root, terms);
  }, [html, loadRemote, relit, surface, terms, text]);

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
