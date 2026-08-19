import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as waitForTurn } from 'node:timers/promises';
import { KeyedWorkQueue } from './work-queue.ts';

test('bounds concurrent work and drains every distinct key', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maximum = 0;
  const completed: string[] = [];
  const queue = new KeyedWorkQueue(2, (_key, error) => { throw error; });

  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    queue.enqueue(key, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      completed.push(key);
      active--;
    });
  }

  await waitForTurn();
  assert.deepEqual(queue.stats(), { active: 2, pending: 3, concurrency: 2 });
  release();
  await queue.onIdle();
  assert.equal(maximum, 2);
  assert.deepEqual(completed.sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('collapses pending duplicates and schedules one rerun for an active key', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const queue = new KeyedWorkQueue(1, (_key, error) => { throw error; });

  queue.enqueue('account', async () => {
    events.push('active');
    await gate;
  });
  await waitForTurn();
  queue.enqueue('account', async () => { events.push('stale rerun'); });
  queue.enqueue('account', async () => { events.push('latest rerun'); });

  release();
  await queue.onIdle();
  assert.deepEqual(events, ['active', 'latest rerun']);
});

test('contains task failures and continues with queued work', async () => {
  const errors: string[] = [];
  const completed: string[] = [];
  const queue = new KeyedWorkQueue(1, (key, error) => errors.push(`${key}:${error.message}`));

  queue.enqueue('bad', async () => { throw new Error('broken'); });
  queue.enqueue('good', async () => { completed.push('good'); });
  await queue.onIdle();

  assert.deepEqual(errors, ['bad:broken']);
  assert.deepEqual(completed, ['good']);
});
