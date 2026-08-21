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
}: {
  sender: Addr;
  profiles: SenderProfile[];
  className: string;
  tint: string;
}) {
  const [failed, setFailed] = useState(false);
  const imageUrl = senderProfileFor(sender, profiles)?.imageUrl;

  return (
    <span className={`${className} sender-avatar`} style={{ '--tint': tint } as React.CSSProperties}>
      {imageUrl && !failed ? (
        <img className="sender-avatar__image" src={imageUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        initials(sender)
      )}
    </span>
  );
}
