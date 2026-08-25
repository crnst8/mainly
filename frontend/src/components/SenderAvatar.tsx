import { useState } from 'react';
import { initials } from '@/lib/format';
import { senderProfileFor } from '@/lib/sender';
import type { Addr, SenderProfile } from '@/lib/types';

/** A monogram until the user explicitly assigns this sender identity a logo. */
export function SenderAvatar({
  sender,
  profiles,
  className,
  tint,
  onClick,
}: {
  sender: Addr;
  profiles: SenderProfile[];
  className: string;
  tint: string;
  /**
   * Makes the avatar a control — clicking it is how a sender gets a picture.
   * Absent, it stays a span: a button that does nothing is a promise the
   * interface cannot keep, and there is one of these on every row.
   */
  onClick?: (e: React.MouseEvent) => void;
}) {
  /* Which URL failed, rather than whether one did. A boolean pinned the
     monogram in place after the first bad address, so correcting the typo
     appeared to do nothing. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = senderProfileFor(sender, profiles)?.imageUrl ?? null;

  const inner =
    imageUrl && failedUrl !== imageUrl ? (
      <img
        className="sender-avatar__image"
        src={imageUrl}
        alt=""
        onError={() => setFailedUrl(imageUrl)}
      />
    ) : (
      initials(sender)
    );

  const style = { '--tint': tint } as React.CSSProperties;

  if (!onClick) {
    return (
      <span className={`${className} sender-avatar`} style={style}>
        {inner}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`${className} sender-avatar sender-avatar--action`}
      style={style}
      title={`${sender.address} — set a picture`}
      aria-label={`Picture for ${sender.address}`}
      onClick={onClick}
    >
      {inner}
    </button>
  );
}
