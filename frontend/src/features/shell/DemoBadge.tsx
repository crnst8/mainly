/**
 * The "this is not your mail" marker, shown only in the hosted demo.
 *
 * Built into the bundle behind `VITE_DEMO=1` rather than detected at runtime,
 * so a self-hosted install cannot render it and the constant folds the whole
 * component out of every other build.
 *
 * It exists because the mock adapter is deliberately indistinguishable from the
 * real one — that is the point of the seam, and it is exactly why a hosted copy
 * of it has to say so out loud.
 */

import { useState } from 'react';
import './demo-badge.css';

const REPO = 'https://github.com/crnst8/mainly';

export function DemoBadge() {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button type="button" className="demo-badge demo-badge--dot" onClick={() => setOpen(true)}>
        demo
      </button>
    );
  }

  return (
    <aside className="demo-badge" aria-label="Demo notice">
      <p className="demo-badge__title">demo</p>
      <p className="demo-badge__body">
        Every message here is invented and lives in this browser tab. Nothing is sent, nothing is
        stored, no server is involved. Reload to reset.
      </p>
      <p className="demo-badge__links">
        <a href={REPO}>github</a>
        <a href="/">about</a>
        <button type="button" onClick={() => setOpen(false)}>
          hide
        </button>
      </p>
    </aside>
  );
}
