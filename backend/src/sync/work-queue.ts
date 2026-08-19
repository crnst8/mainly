/**
 * A bounded, keyed work queue.
 *
 * Sync triggers arrive from polling, IDLE-adjacent actions and manual refresh.
 * Bursts for one account collapse to one pending rerun, while the global cap
 * reserves database and IMAP capacity for interactive requests.
 */

export type Work = () => Promise<void>;

export class KeyedWorkQueue {
  private readonly concurrency: number;
  private readonly onError: (key: string, error: Error) => void;
  private readonly pending = new Map<string, Work>();
  private readonly active = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private stopped = false;

  constructor(concurrency: number, onError: (key: string, error: Error) => void) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Work queue concurrency must be a positive integer');
    }
    this.concurrency = concurrency;
    this.onError = onError;
  }

  enqueue(key: string, work: Work): void {
    if (this.stopped) return;
    // Replacing a pending entry is intentional. If the account is active this
    // becomes one rerun with the newest credentials; if it was merely pending,
    // ten clicks still become one pass.
    this.pending.set(key, work);
    this.pump();
  }

  stats(): { active: number; pending: number; concurrency: number } {
    return { active: this.active.size, pending: this.pending.size, concurrency: this.concurrency };
  }

  onIdle(): Promise<void> {
    if (!this.active.size && !this.pending.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    await this.onIdle();
  }

  private pump(): void {
    while (!this.stopped && this.active.size < this.concurrency) {
      const next = [...this.pending].find(([key]) => !this.active.has(key));
      if (!next) break;
      const [key, work] = next;
      this.pending.delete(key);
      this.active.add(key);

      void Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          try {
            this.onError(key, error instanceof Error ? error : new Error(String(error)));
          } catch {
            // Error reporting must not become the queue's unhandled rejection.
          }
        })
        .finally(() => {
          this.active.delete(key);
          this.pump();
          this.resolveIdle();
        });
    }
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.active.size || this.pending.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
