/**
 * Notifications, and the filing the sync worker does for the user.
 *
 * Two kinds of setting live on the Notifications pane and they are kept apart
 * on screen because they are kept apart in fact: whether *this browser*
 * receives anything is a push subscription that belongs to the device, and
 * what notifies is a preference stored once for every device.
 */

import { useEffect, useState } from 'react';
import { Button, IconButton, Row, Segmented, Spinner, Toggle } from '@/components/ui';
import { Trash } from '@/components/icons';
import { getApi } from '@/lib/api';
import { relative } from '@/lib/format';
import {
  deviceLabel,
  disablePush,
  enablePush,
  permission,
  pushSupport,
  thisDevice,
  type PushSupport,
} from '@/lib/notifications';
import { useStore } from '@/lib/store';
import type { Account, Id, NotificationContent, NotificationPreferences, Priority, PushDevice } from '@/lib/types';

const TIERS: Priority[] = ['critical', 'high', 'normal', 'low', 'muted'];

/** Why this browser cannot be switched on, when it cannot. */
const UNAVAILABLE: Record<Exclude<PushSupport, 'ok'>, string> = {
  'needs-install': 'Add Mainly to the Home Screen and open it from there.',
  insecure: 'Needs an https address.',
  'no-worker': 'Not available in a development build.',
  unsupported: 'This browser cannot receive notifications.',
};

export function Notifications() {
  const n = useStore((s) => s.prefs!.notifications);
  const savePrefs = useStore((s) => s.savePrefs);
  const set = (patch: Partial<NotificationPreferences>) =>
    void savePrefs({ notifications: { ...n, ...patch } });

  const support = pushSupport();
  const [device, setDevice] = useState<PushDevice | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState<'toggle' | 'test' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  const reload = async () => {
    const api = await getApi();
    const [mine, all] = await Promise.all([
      thisDevice(api).catch(() => null),
      api.listPushDevices().catch(() => [] as PushDevice[]),
    ]);
    setDevice(mine);
    setDevices(all);
  };

  useEffect(() => {
    void reload();
  }, []);

  async function toggleDevice(on: boolean) {
    setBusy('toggle');
    setFailure(null);
    setTested(false);
    try {
      const api = await getApi();
      if (on) setDevice(await enablePush(api));
      else {
        await disablePush(api, device?.id ?? null);
        setDevice(null);
      }
      await reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not change notifications here');
    } finally {
      setBusy(null);
    }
  }

  async function test(id: Id) {
    setBusy('test');
    setFailure(null);
    try {
      await (await getApi()).testPushDevice(id);
      setTested(true);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'The test notification failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: Id) {
    await (await getApi()).removePushDevice(id).catch(() => undefined);
    if (device?.id === id) await disablePush(await getApi(), null);
    await reload();
  }

  const blocked = permission() === 'denied';
  const others = devices.filter((d) => d.id !== device?.id);

  return (
    <>
      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">This device</span>
        </div>
        <Row
          title={deviceLabel()}
          desc={
            support !== 'ok'
              ? UNAVAILABLE[support]
              : blocked
                ? 'Blocked in this browser’s site settings.'
                : undefined
          }
        >
          <div className="notif__device">
            {busy === 'toggle' && <Spinner />}
            {device && (
              <Button size="sm" disabled={busy !== null} onClick={() => void test(device.id)}>
                {busy === 'test' ? <Spinner /> : null}
                {tested ? 'Sent' : 'Send test'}
              </Button>
            )}
            <Toggle
              label="Notifications on this device"
              checked={!!device}
              onChange={(on) => {
                if (support === 'ok' && !blocked && busy === null) void toggleDevice(on);
              }}
            />
          </div>
        </Row>
        {failure && <p className="settings__note settings__note--error">{failure}</p>}
      </section>

      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">New mail</span>
        </div>
        <Row title="Notify" desc="Every device">
          <Toggle label="Notify on new mail" checked={n.enabled} onChange={(enabled) => set({ enabled })} />
        </Row>
        <Row title="Show">
          <Segmented<NotificationContent>
            ariaLabel="What a notification shows"
            value={n.content}
            onChange={(content) => set({ content })}
            options={[
              { value: 'full', label: 'Subject', hint: 'Sender, subject and preview' },
              { value: 'sender', label: 'Sender', hint: 'Sender and mailbox only' },
              { value: 'count', label: 'Count', hint: 'Only how many arrived' },
            ]}
          />
        </Row>
        <Row title="Folders">
          <Segmented<NotificationPreferences['folders']>
            ariaLabel="Which folders notify"
            value={n.folders}
            onChange={(folders) => set({ folders })}
            options={[
              { value: 'inbox', label: 'Inbox' },
              { value: 'all', label: 'All', hint: 'Every folder except Sent, Drafts, Junk and Trash' },
            ]}
          />
        </Row>
        <Row title="Group by mailbox">
          <Toggle label="Group by mailbox" checked={n.group} onChange={(group) => set({ group })} />
        </Row>
        <Row title="Silent">
          <Toggle label="Silent notifications" checked={n.silent} onChange={(silent) => set({ silent })} />
        </Row>
        <Row title="Priority">
          <div className="seg" role="group" aria-label="Priority tiers that notify">
            {TIERS.map((t) => (
              <button
                key={t}
                type="button"
                className="seg__item"
                aria-pressed={n.tiers.includes(t)}
                title={t}
                onClick={() =>
                  set({ tiers: n.tiers.includes(t) ? n.tiers.filter((x) => x !== t) : [...n.tiers, t] })
                }
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Quiet hours">
          <div className="notif__hours">
            <input
              type="time"
              className="input"
              aria-label="Quiet hours start"
              value={n.quietHours.start}
              disabled={!n.quietHours.enabled}
              onChange={(e) => set({ quietHours: quiet(n, { start: e.target.value }) })}
            />
            <span aria-hidden="true">–</span>
            <input
              type="time"
              className="input"
              aria-label="Quiet hours end"
              value={n.quietHours.end}
              disabled={!n.quietHours.enabled}
              onChange={(e) => set({ quietHours: quiet(n, { end: e.target.value }) })}
            />
            <Toggle
              label="Quiet hours"
              checked={n.quietHours.enabled}
              onChange={(enabled) => set({ quietHours: quiet(n, { enabled }) })}
            />
          </div>
        </Row>
      </section>

      <AccountChecklist
        title="Mailboxes"
        ariaVerb="Notify for"
        isOn={(id) => !n.mutedAccounts.includes(id)}
        onChange={(ids, on) =>
          set({
            mutedAccounts: on
              ? n.mutedAccounts.filter((x) => !ids.includes(x))
              : [...new Set([...n.mutedAccounts, ...ids])],
          })
        }
      />

      {others.length > 0 && (
        <section className="settings__section">
          <div className="settings__sectionhead">
            <span className="label">Other devices</span>
          </div>
          {others.map((d) => (
            <Row
              key={d.id}
              title={d.label || 'Unnamed device'}
              desc={d.lastUsedAt ? `Last notified ${relative(d.lastUsedAt)}` : `Added ${relative(d.createdAt)}`}
            >
              <div className="notif__device">
                <Button size="sm" disabled={busy !== null} onClick={() => void test(d.id)}>
                  Send test
                </Button>
                <IconButton label={`Remove ${d.label}`} onClick={() => void remove(d.id)}>
                  <Trash size={14} />
                </IconButton>
              </div>
            </Row>
          ))}
        </section>
      )}
    </>
  );
}

/** A quiet-hours change, stamped with this device's zone: the server compares
 *  against the clock of whoever last set the window. */
function quiet(n: NotificationPreferences, patch: Partial<NotificationPreferences['quietHours']>) {
  let timeZone = n.quietHours.timeZone;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
  } catch {
    /* keep the stored zone */
  }
  return { ...n.quietHours, ...patch, timeZone };
}

/* ── Spam and folders ─────────────────────────────────────────────────────── */

export function Filtering() {
  const m = useStore((s) => s.prefs!.mailHandling);
  const savePrefs = useStore((s) => s.savePrefs);
  const set = (patch: Partial<typeof m>) => void savePrefs({ mailHandling: { ...m, ...patch } });

  return (
    <>
      <section className="settings__section">
        <Row title="Create missing Trash and Junk" desc="On the mail server, for mailboxes without them">
          <Toggle
            label="Create missing Trash and Junk folders"
            checked={m.createMissingFolders}
            onChange={(createMissingFolders) => set({ createMissingFolders })}
          />
        </Row>
        <Row title="Move spam to Junk" desc="Mail the server tagged ***SPAM*** or X-Spam-Flag: YES">
          <Toggle label="Move spam to Junk" checked={m.spamFilter} onChange={(spamFilter) => set({ spamFilter })} />
        </Row>
      </section>

      {m.spamFilter && (
        <AccountChecklist
          title="Filter spam in"
          ariaVerb="Filter spam in"
          isOn={(id) => !m.spamFilterExcluded.includes(id)}
          onChange={(ids, on) =>
            set({
              spamFilterExcluded: on
                ? m.spamFilterExcluded.filter((x) => !ids.includes(x))
                : [...new Set([...m.spamFilterExcluded, ...ids])],
            })
          }
        />
      )}
    </>
  );
}

/** One switch per mailbox, with all-on and all-off for the forty-five-mailbox
 *  case where flipping each is the slow way. */
function AccountChecklist({
  title,
  ariaVerb,
  isOn,
  onChange,
}: {
  title: string;
  ariaVerb: string;
  isOn: (id: Id) => boolean;
  onChange: (ids: Id[], on: boolean) => void;
}) {
  const accounts = useStore((s) => s.accounts);
  const ids = accounts.map((a: Account) => a.id);
  if (!accounts.length) return null;

  return (
    <section className="settings__section">
      <div className="settings__sectionhead settings__sectionhead--split">
        <span className="label">{title}</span>
        <div className="notif__device">
          <Button size="sm" disabled={ids.every(isOn)} onClick={() => onChange(ids, true)}>
            All on
          </Button>
          <Button size="sm" disabled={!ids.some(isOn)} onClick={() => onChange(ids, false)}>
            All off
          </Button>
        </div>
      </div>
      {accounts.map((a) => (
        <Row key={a.id} title={a.label || a.address} desc={a.label && a.label !== a.address ? a.address : undefined}>
          <Toggle label={`${ariaVerb} ${a.address}`} checked={isOn(a.id)} onChange={(on) => onChange([a.id], on)} />
        </Row>
      ))}
    </section>
  );
}
