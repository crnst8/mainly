/**
 * This browser's half of push notifications: permission, the push
 * subscription, and what happens when a notification is clicked.
 *
 * Which mail notifies is decided on the server from `NotificationPreferences`.
 * What lives here is per device, because a subscription belongs to one browser:
 * turning notifications on for a phone does not turn them on for a laptop.
 *
 * The service worker (public/sw.js) draws each push; it is registered only in
 * production builds, so in development every function here reports
 * `no-worker` rather than hanging on `serviceWorker.ready`.
 */

import type { MailApi } from './api';
import type { PushDevice } from './types';

export type PushSupport =
  /** Everything is in place. */
  | 'ok'
  /** iPhone and iPad deliver web push only to an app added to the Home Screen. */
  | 'needs-install'
  /** Push needs https (or localhost). */
  | 'insecure'
  /** No service worker: a development build, or a browser without one. */
  | 'no-worker'
  /** The browser has no Push API at all. */
  | 'unsupported';

const isAppleTouch = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  if (isAppleTouch() && !standalone() && !('PushManager' in window)) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'unsupported';
  if (!import.meta.env.PROD) return 'no-worker';
  return 'ok';
}

/** The permission the browser holds for this origin. */
export const permission = (): NotificationPermission | 'unsupported' =>
  'Notification' in window ? Notification.permission : 'unsupported';

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport() !== 'ok') return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** "Safari on iPhone", "Chrome on macOS" — enough to tell devices apart in a
 *  list, and nothing a person would mind the server holding. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || isAppleTouch()
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'this device';
  return `${browser} on ${os}${standalone() ? ' (app)' : ''}`;
}

const toBytes = (b64url: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const toB64url = (buffer: ArrayBuffer | null): string =>
  buffer
    ? btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : '';

/** Register this browser with the server, subscribing first if it has not.
 *  Asks for permission, so call it from a click. */
export async function enablePush(api: MailApi): Promise<PushDevice> {
  const reg = await registration();
  if (!reg) throw new Error('This browser cannot receive notifications here');
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error('Notifications are blocked for this site in the browser’s settings');

  const key = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made against another key (a reinstalled server) can never
  // be delivered to; replace it rather than registering a dead one.
  if (sub && toB64url(sub.options.applicationServerKey) !== key) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  return register(api, sub);
}

function register(api: MailApi, sub: PushSubscription): Promise<PushDevice> {
  return api.addPushDevice({
    endpoint: sub.endpoint,
    keys: { p256dh: toB64url(sub.getKey('p256dh')), auth: toB64url(sub.getKey('auth')) },
    label: deviceLabel(),
  });
}

/** Stop this browser receiving notifications, here and on the server. */
export async function disablePush(api: MailApi, deviceId: string | null): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  await sub?.unsubscribe().catch(() => undefined);
  if (deviceId) await api.removePushDevice(deviceId);
}

/**
 * This browser's device row, refreshed, or null when it is not subscribed.
 *
 * Re-registering on every boot is what keeps the two sides agreeing: browsers
 * rotate endpoints, and a server restored from an old backup has never heard
 * of this one. The server upserts on the endpoint, so this is idempotent.
 */
export async function thisDevice(api: MailApi): Promise<PushDevice | null> {
  if (permission() !== 'granted') return null;
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return null;
  return register(api, sub).catch(() => null);
}

/** Notification clicks route inside an open window rather than reloading it,
 *  and opening the app clears what it would otherwise show twice. */
export function watchNotifications(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; path?: string } | null;
    if (data?.type !== 'mainly:open' || typeof data.path !== 'string') return;
    // Same origin only; the worker builds the path, but a message is a message.
    if (!data.path.startsWith('/')) return;
    history.pushState({}, '', data.path);
    dispatchEvent(new PopStateEvent('popstate'));
  });

  const clear = async () => {
    if (document.visibilityState !== 'visible') return;
    const reg = await registration();
    if (!reg) return;
    for (const n of await reg.getNotifications()) n.close();
    await navigator.clearAppBadge?.().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', () => void clear());
  void clear();
}
