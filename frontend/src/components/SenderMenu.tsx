/**
 * Give a sender a picture, from wherever you are looking at their mail.
 *
 * The monogram is a fallback, not a choice, and the place you notice it is the
 * list — so the fix belongs there too. Clicking the monogram opens this;
 * settings still holds the full identity editor, and this writes to the same
 * `senderProfiles` it does.
 *
 * Two things it deliberately does not do. It does not fetch anything: a logo is
 * a URL you supply, because guessing one from the domain would mean this client
 * quietly asking a third party about every sender you receive mail from. And it
 * does not take an http:// URL — a page served over HTTPS loading a logo over
 * plaintext leaks who your correspondents are to anything on the path.
 *
 * A picture set here covers the whole sender identity, which is one domain and
 * its subdomains until the user widens it in settings. The panel says so, so
 * nobody is surprised when one logo lands on forty rows.
 */

import { useState } from 'react';
import { Close, Warning } from './icons';
import { ContextMenu, MenuItem, type ContextMenuController } from './context-menu';
import { PopLabel, PopSep } from './ui';
import { senderDomain, senderImageUrl, senderProfileFor, setSenderImage } from '@/lib/sender';
import { useStore } from '@/lib/store';
import { SenderAvatar } from './SenderAvatar';
import type { Addr } from '@/lib/types';

export function SenderMenu({ controller }: { controller: ContextMenuController<Addr> }) {
  return (
    <ContextMenu controller={controller} width={280}>
      {(sender, close) => <Body sender={sender} close={close} />}
    </ContextMenu>
  );
}

function Body({ sender, close }: { sender: Addr; close: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const savePrefs = useStore((s) => s.savePrefs);
  const profiles = prefs?.senderProfiles ?? [];
  const profile = senderProfileFor(sender, profiles);
  const domain = senderDomain(sender.address);

  const [draft, setDraft] = useState(profile?.imageUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  /* A sender whose address has no usable domain cannot be given an identity —
     the domain *is* the identity here. Say so rather than offering a field that
     silently does nothing. */
  if (!domain) {
    return (
      <>
        <PopLabel>{sender.address || 'Unknown sender'}</PopLabel>
        <div className="pop__empty">
          <Warning size={13} /> This address has no domain to attach a picture to.
        </div>
      </>
    );
  }

  const save = () => {
    const url = senderImageUrl(draft);
    if (draft.trim() && !url) {
      setError('Needs to be an https:// image address.');
      return;
    }
    void savePrefs({ senderProfiles: setSenderImage(sender, profiles, url) });
    close();
  };

  const covers = profile ? profile.domains.join(', ') : domain;

  return (
    <>
      <PopLabel>{sender.name?.trim() || sender.address}</PopLabel>

      <div className="senderpop">
        <SenderAvatar
          className="senderpop__preview"
          sender={sender}
          profiles={
            // Preview the draft, not the saved value — typing a URL and seeing
            // nothing change until you commit is how you find out it was wrong
            // one step too late.
            senderImageUrl(draft)
              ? setSenderImage(sender, profiles, senderImageUrl(draft))
              : profiles
          }
          tint="var(--accent)"
        />
        <div className="senderpop__text">
          <div className="senderpop__addr truncate">{sender.address}</div>
          <div className="senderpop__scope truncate" title={covers}>
            Applies to {covers} and subdomains
          </div>
        </div>
      </div>

      <div className="pop__field">
        <input
          className="input"
          autoFocus
          type="url"
          inputMode="url"
          placeholder="https://example.com/logo.png"
          aria-label="Sender image address"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') e.stopPropagation();
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
          }}
        />
      </div>

      {error && <div className="senderpop__error">{error}</div>}

      <MenuItem
        hint="↵"
        disabled={draft.trim() === (profile?.imageUrl ?? '')}
        onClick={save}
      >
        {profile?.imageUrl ? 'Update image' : 'Attach image'}
      </MenuItem>

      {profile?.imageUrl && (
        <MenuItem
          icon={<Close size={13} />}
          onClick={() => {
            void savePrefs({ senderProfiles: setSenderImage(sender, profiles, null) });
            close();
          }}
        >
          Remove image
        </MenuItem>
      )}

      <PopSep />

      <MenuItem onClick={() => useStore.getState().setSettings('senders')}>
        Sender identities…
      </MenuItem>
    </>
  );
}
