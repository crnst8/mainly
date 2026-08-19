/**
 * The API contract exists in two places on purpose — the frontend must build
 * without the backend present, and vice versa. This fails the build if they
 * drift, which is the only thing that makes duplication safe.
 *
 * Two files are shared. `types.ts` is the shape of everything that crosses the
 * wire. `search.ts` is the search syntax: a query that means one thing in the
 * mock adapter and another in Postgres is worse than having no syntax, so the
 * parser is copied rather than reimplemented.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SHARED = ['types.ts', 'search.ts'];

const hash = async (url) => createHash('sha256').update(await readFile(url)).digest('hex');

let drifted = false;

for (const name of SHARED) {
  const front = new URL(`../../frontend/src/lib/${name}`, import.meta.url);
  const back = new URL(`../src/contract/${name}`, import.meta.url);
  const [a, b] = await Promise.all([hash(front), hash(back)]);
  if (a !== b) {
    drifted = true;
    console.error(
      `Contract drift: frontend/src/lib/${name} and backend/src/contract/${name} differ.\n` +
        'Edit one, then copy it over the other:\n' +
        `  cp frontend/src/lib/${name} backend/src/contract/${name}`,
    );
  }
}

if (drifted) process.exit(1);

console.log('contract in sync');
