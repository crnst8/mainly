/**
 * Sender identity is intentionally explicit. A domain only stands for itself
 * and its subdomains once the user has put it in a profile; we never guess
 * that two unrelated registrable domains are the same organisation.
 */

import type { Addr, Preferences, SenderProfile } from './types';

/** A canonical domain suitable for matching email senders. */
export function senderDomain(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const domain = (raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw).replace(/^\.+|\.+$/g, '');
  if (!domain || domain.length > 253 || /[^a-z0-9.-]/.test(domain) || !domain.includes('.')) return null;
  if (domain.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))
    return null;
  return domain;
}

/** Accept a pasted comma-, space-, or newline-separated set of domains. */
export function senderDomains(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map(senderDomain).filter((domain): domain is string => domain !== null))];
}

/** Whether a domain is the authorised domain itself or one of its subdomains. */
export function isAuthorisedSenderDomain(domain: string, authorisedDomain: string): boolean {
  return domain === authorisedDomain || domain.endsWith(`.${authorisedDomain}`);
}

/** The narrowest matching profile wins when authorised domains overlap. */
export function senderProfileFor(sender: Addr, profiles: SenderProfile[]): SenderProfile | null {
  const domain = senderDomain(sender.address);
  if (!domain) return null;

  let match: SenderProfile | null = null;
  let specificity = -1;
  for (const profile of profiles) {
    for (const rawDomain of profile.domains) {
      const authorisedDomain = senderDomain(rawDomain);
      if (authorisedDomain && isAuthorisedSenderDomain(domain, authorisedDomain) && authorisedDomain.length > specificity) {
        match = profile;
        specificity = authorisedDomain.length;
      }
    }
  }
  return match;
}

export function sameSender(a: Addr, b: Addr, profiles: SenderProfile[]): boolean {
  const aProfile = senderProfileFor(a, profiles);
  const bProfile = senderProfileFor(b, profiles);
  if (aProfile || bProfile) return aProfile?.id === bProfile?.id;
  return senderDomain(a.address) === senderDomain(b.address);
}

export function remoteImagesAllowed(prefs: Preferences | null | undefined, sender: Addr | null | undefined): boolean {
  if (!prefs || !sender) return false;
  if (prefs.remoteImages === 'always') return true;
  return prefs.remoteImages === 'trusted' && senderProfileFor(sender, prefs.senderProfiles)?.allowRemoteImages === true;
}

/** Add the sender's current domain as an explicit, trusted identity. */
export function allowImagesFromSender(sender: Addr, profiles: SenderProfile[]): SenderProfile[] {
  const existing = senderProfileFor(sender, profiles);
  if (existing) return profiles.map((profile) => (profile.id === existing.id ? { ...profile, allowRemoteImages: true } : profile));

  const domain = senderDomain(sender.address);
  if (!domain) return profiles;
  return [
    ...profiles,
    {
      id: domain,
      name: sender.name?.trim() || null,
      domains: [domain],
      imageUrl: null,
      allowRemoteImages: true,
    },
  ];
}

/** Only an explicitly supplied HTTPS URL may become a sender logo. */
export function senderImageUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
