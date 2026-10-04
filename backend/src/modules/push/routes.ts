/**
 * Push subscriptions: the devices that receive new-mail notifications.
 *
 * Session only. A device registered here receives sender and subject lines,
 * so registering one is a way to read mail; an agent token must not be able
 * to point that at an endpoint of its choosing.
 */

import type { FastifyInstance } from 'fastify';
import { one, query } from '../../db/index.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import type { PushDevice, PushSubscriptionInput } from '../../contract/types.ts';
import { isPushEndpoint } from '../../push/encrypt.ts';
import { vapidKeys } from '../../push/webpush.ts';
import { sendAll } from '../../push/notify.ts';

interface DeviceRow {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}

const toDevice = (r: DeviceRow): PushDevice => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
});

const decodedLength = (v: unknown): number =>
  typeof v === 'string' && /^[A-Za-z0-9_-]+=*$/.test(v) ? Buffer.from(v, 'base64url').length : -1;

const sessionOnly = { config: { sessionOnly: true } };

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.get('/push/key', sessionOnly, async () => ({ publicKey: (await vapidKeys()).publicKey }));

  app.get('/push/devices', sessionOnly, async (req) => {
    const rows = await query<DeviceRow>(
      `SELECT id, label, created_at, last_used_at FROM push_subscriptions
        WHERE user_id = $1 ORDER BY created_at`,
      [req.userId],
    );
    return rows.map(toDevice);
  });

  /** Subscribe this browser, or refresh it. The endpoint identifies the
   *  browser, so the same one subscribing again updates its row. */
  app.post<{ Body: PushSubscriptionInput }>('/push/devices', sessionOnly, async (req) => {
    const { endpoint, keys, label } = req.body ?? ({} as PushSubscriptionInput);
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isPushEndpoint(endpoint))
      throw badRequest('That push endpoint is not on a known browser push service');
    // An uncompressed P-256 point and a 16-byte secret, per RFC 8291.
    if (decodedLength(keys?.p256dh) !== 65 || decodedLength(keys?.auth) !== 16)
      throw badRequest('Malformed subscription keys');
    const row = await one<DeviceRow>(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth, label = EXCLUDED.label
       RETURNING id, label, created_at, last_used_at`,
      [req.userId, endpoint, keys.p256dh, keys.auth, String(label ?? '').slice(0, 120)],
    );
    return toDevice(row!);
  });

  app.delete<{ Params: { id: string } }>('/push/devices/:id', sessionOnly, async (req, reply) => {
    await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND id = $2', [
      req.userId,
      req.params.id,
    ]);
    return reply.code(204).send();
  });

  /** A sample notification, so the person can see what one looks like and
   *  that the device receives them at all. */
  app.post<{ Params: { id: string } }>('/push/devices/:id/test', sessionOnly, async (req, reply) => {
    const device = await one<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 AND id = $2',
      [req.userId, req.params.id],
    );
    if (!device) throw notFound('Device');
    const result = await sendAll(
      [device],
      [{ tag: 'test', title: 'Mainly', body: 'Notifications work on this device.', url: '', silent: false, count: 1 }],
      { ttl: 60, urgency: 'high' },
    );
    if (result.gone)
      throw badRequest('The push service no longer knows this device. Turn notifications on again here.');
    if (!result.sent) throw badRequest('The push service refused the notification');
    return reply.code(204).send();
  });
}
