/**
 * Pushing a message to the printer.
 *
 * The reason this exists is narrow and worth stating: shops and banks send
 * receipts *in the body*, not as an attachment. There is no file to save. The
 * only way to keep one is to print it, and every modern browser can print to
 * PDF — so the app's whole job is to hand the browser a clean document and get
 * out of the way.
 *
 * "Clean" means three things, and the third is the one people actually notice:
 *
 *  1. No app chrome. Not a hidden toolbar, not a print stylesheet fighting a
 *     flex layout — a separate document containing the message and nothing else.
 *  2. The right filename. Chrome and Safari name the PDF after the document
 *     title, so the title is the subject line. A folder of receipts named
 *     "Invoice 8841 — Peckham Rye" beats one named "mainly.html" forever.
 *  3. Paper-friendly colour. Mail is designed for a screen; a dark header band
 *     is a millimetre of toner. `relight` in `ink` mode lifts exactly those and
 *     leaves an already-black-on-white receipt untouched.
 *
 * Printing an iframe rather than the page is what buys (1). The document is
 * built same-origin and written directly, so it inherits the app's CSP and
 * nothing crosses a network boundary that was not already going to.
 */

import {
  dropDeferredImages,
  escapeHtml,
  hardenLinks,
  linkifyInDom,
  loadDeferredImages,
  sanitiseBody,
} from './mail-html';
import { readIntent, relight } from './relight';
import type { Addr, Message } from './types';

/** `paper` re-lights for black-on-white; `original` prints what the sender
 *  drew, backgrounds and all. Both print what the preview shows. */
export type PrintColors = 'paper' | 'original';

/** How long remote images get to arrive before we print without them. A print
 *  dialog that never opens is worse than a receipt missing a logo. */
const IMAGE_GRACE_MS = 3000;

/**
 * iOS has no windowed print dialog and does not reliably print a frame it
 * cannot show, so there it gets a real tab and the system share sheet — which
 * is also where "Save to Files" lives, the thing an iPhone user is after.
 */
const IOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function printMessage(
  message: Message,
  options: { colors: PrintColors; loadRemote: boolean },
): void {
  const html = printDocument(message, options.colors);
  const finish = (win: Window, doc: Document) => {
    const body = doc.querySelector<HTMLElement>('.mail');
    if (body) {
      if (options.loadRemote) loadDeferredImages(body);
      else dropDeferredImages(body);
      linkifyInDom(body);
      hardenLinks(body);
      // After the images are settled, so an image's own box does not shift the
      // areas the light/dark decision is weighed against.
      void imagesSettled(doc).then(() => {
        if (options.colors === 'paper') {
          relight(body, 'ink');
        } else {
          /*
           * "As sent" on a page that is white whatever anyone wants.
           *
           * Paper mode has no problem here — it lifts light ink to dark and the
           * message reads. This one has to keep the sender's colours, so a
           * message that brought no background and wrote in light ink would
           * print white on white: a blank sheet, which is the one outcome worse
           * than a heavy one. It gets the dark surface it was drawn for.
           */
          const verdict = readIntent(body);
          if (!verdict.standsAlone && verdict.inkForDark) body.dataset.surface = 'dark';
        }
        push(win);
      });
      return;
    }
    void imagesSettled(doc).then(() => push(win));
  };

  if (IOS && openInTab(html, finish)) return;
  openInFrame(html, finish);
}

function push(win: Window): void {
  try {
    win.focus();
    win.print();
  } catch {
    /* A blocked or unsupported print leaves the document on screen in the tab
       case and does nothing in the frame case. Neither is worth a toast. */
  }
}

/* ── Destinations ─────────────────────────────────────────────────────────── */

/**
 * A frame parked off-screen rather than hidden.
 *
 * `display: none` is not laid out, and an unlaid-out document has no computed
 * colours to read and nothing for the browser to paginate. It has to be
 * rendered; it just does not have to be anywhere you can see.
 */
function openInFrame(html: string, ready: (win: Window, doc: Document) => void): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'Print');
  frame.style.cssText =
    'position:fixed;left:-10000px;top:0;width:860px;height:1200px;border:0;opacity:0;pointer-events:none;';
  document.body.append(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }

  doc.open();
  doc.write(html);
  doc.close();

  // Removing the frame while the job is queued cancels it in some browsers, so
  // it leaves on `afterprint` — with a timer behind it, because Safari does not
  // always fire one for a frame and a leaked iframe per print is still a leak.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 60_000);

  ready(win, doc);
}

/** Returns false when the browser refused the window, so the caller can fall
 *  back rather than leaving the user with nothing. */
function openInTab(html: string, ready: (win: Window, doc: Document) => void): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  ready(win, win.document);
  return true;
}

/** Resolve once every image has loaded or failed, or once the grace period is
 *  up — whichever comes first. */
function imagesSettled(doc: Document, ms = IMAGE_GRACE_MS): Promise<void> {
  const pending = [...doc.images].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/* ── The document ─────────────────────────────────────────────────────────── */

const addrs = (list: Addr[]): string =>
  list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

/**
 * Absolute, and only absolute.
 *
 * The reader shows "Tue 4 Mar 2025, 14:32 · 3d ago" because on screen the
 * relative half is the part you read. On a sheet of paper filed in a drawer,
 * "3d ago" is measured from a moment nobody can recover, so it is a lie by
 * next week. Paper gets the date and the timezone it happened in.
 */
function printedDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function printDocument(message: Message, colors: PrintColors): string {
  const subject = message.subject || '(no subject)';
  const rows: [string, string][] = [
    ['From', addrs([message.from])],
    ['To', addrs(message.to) || '—'],
  ];
  if (message.cc.length) rows.push(['Cc', addrs(message.cc)]);
  rows.push(['Date', printedDate(message.date)]);

  const body =
    message.bodyHtml !== null
      ? sanitiseBody(message.bodyHtml)
      : `<pre class="plain">${escapeHtml(message.bodyText ?? '')}</pre>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<header class="head">
  <h1>${escapeHtml(subject)}</h1>
  <dl>${rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')}</dl>
</header>
<main class="mail" data-colors="${colors}">${body}</main>
</body></html>`;
}

/**
 * The print stylesheet.
 *
 * Points rather than pixels, because the destination is a page and a point is
 * the unit a page is measured in. Nothing here references an app token: this
 * document has no access to them and should not — it is a printed message, not
 * a screenshot of a mail client.
 */
const PRINT_CSS = `
  @page { margin: 14mm; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; }
  body {
    color: #14181f;
    font: 10.5pt/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    /* Print what the preview showed. Without this, browsers drop every
       background colour — including the ones "paper" mode just lifted to make
       a dark header band safe, which would leave white text on white paper. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .head {
    border-bottom: 0.6pt solid #9aa1ab;
    padding-bottom: 9pt;
    margin-bottom: 14pt;
  }
  .head h1 {
    margin: 0 0 7pt;
    font-size: 14pt;
    line-height: 1.25;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .head dl {
    margin: 0;
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 1.5pt 9pt;
    font-size: 8.5pt;
    line-height: 1.4;
  }
  .head dt { color: #6b7280; }
  .head dd { margin: 0; overflow-wrap: anywhere; }
  .mail { overflow-wrap: break-word; }
  /* Only ever set on an "as sent" print of a message that brought no surface
     of its own — see the note at the call site. */
  .mail[data-surface='dark'] {
    background: #14181f;
    color: #e9ebee;
    padding: 10pt;
  }
  .mail img { max-width: 100%; height: auto; }
  .mail table { border-collapse: collapse; max-width: 100%; }
  .mail td, .mail th { padding: 2pt 4pt; }
  .mail a { color: inherit; text-decoration: underline; }
  .mail blockquote {
    margin: 8pt 0;
    padding-left: 8pt;
    border-left: 1pt solid #c3c8d0;
  }
  .plain, .mail pre {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 9.5pt;
    margin: 0;
  }
  /* Pagination. A row split across a page break is the one printing artefact
     that makes a receipt genuinely hard to read, and a heading stranded at the
     foot of a page is the second. */
  tr, img, blockquote { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
`;
