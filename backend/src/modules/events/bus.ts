/**
 * Server-sent event fan-out.
 *
 * In-process for `ROLE=all` (the self-hosted default). When API and sync run as
 * separate deployments, this becomes a Postgres `LISTEN/NOTIFY` bridge — the
 * publish/subscribe surface here is deliberately narrow so that swap is a
 * change to one file.
 */

import type { ServerEvent } from '../../contract/types.ts';

type Listener = (event: ServerEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(userId: string, listener: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(userId);
  };
}

export function publish(userId: string, event: ServerEvent): void {
  for (const listener of listeners.get(userId) ?? []) {
    try {
      listener(event);
    } catch (err) {
      // One broken stream must not take out the others.
      console.error({ err: (err as Error).message }, 'sse listener threw');
    }
  }
}

export const listenerCount = (userId: string): number => listeners.get(userId)?.size ?? 0;
