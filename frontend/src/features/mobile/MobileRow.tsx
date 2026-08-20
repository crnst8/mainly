/**
 * The mobile list row — the mockup's shape, one thumb-friendly line. No avatar,
 * no checkbox, no hover actions; the account colour stripe is the identity, and
 * a swipe (wrapped by `SwipeRow`) does the acting.
 */

import { Reply } from '@/components/icons';
import { displayName, listDate } from '@/lib/format';
import { useAccountColor } from '@/lib/store';
import type { MessageSummary } from '@/lib/types';

export function MobileRow({ message: m }: { message: MessageSummary }) {
  const colorOf = useAccountColor();
  const tint = colorOf(m.accountId);

  return (
    <div
      className="mrow"
      style={{ '--tint': tint } as React.CSSProperties}
      data-read={m.seen || undefined}
      data-flagged={m.flagged || undefined}
    >
      <span className="mrow__stripe" />
      <div className="mrow__main">
        <div className="mrow__line">
          {m.answered && <Reply className="mrow__answered" size={11} />}
          <span className="mrow__sender truncate">{displayName(m.from)}</span>
          <span className="mrow__subject truncate">{m.subject || '(no subject)'}</span>
        </div>
        <div className="mrow__preview">
          <span className="mrow__previewtext truncate">{m.preview}</span>
          <span className="mrow__date tnum">{listDate(m.date)}</span>
        </div>
      </div>
      {m.flagged && <span className="mrow__flag">!</span>}
    </div>
  );
}
