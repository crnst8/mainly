/**
 * Create an application user.
 *
 * This app has no open registration: users are created by the operator, which
 * for a self-hosted mail client is the same person.
 *
 *   dev:  node --experimental-strip-types src/cli/create-user.ts you@example.com
 *   prod: node dist/cli/create-user.js you@example.com
 *
 * The password comes from the PASSWORD env var, or is generated and printed.
 * It is never read from argv — argv is visible in `ps`.
 */

import { randomBytes } from 'node:crypto';
import { createUser } from '../modules/auth/index.ts';
import { pool } from '../db/index.ts';

const email = process.argv[2];
if (!email?.includes('@')) {
  console.error('Usage: create-user <email>   (password from $PASSWORD, else generated)');
  process.exit(1);
}

const password = process.env.PASSWORD ?? randomBytes(18).toString('base64url');
const generated = !process.env.PASSWORD;

try {
  const id = await createUser(email, password);
  console.log(`created user ${email} (${id})`);
  if (generated) console.log(`password: ${password}`);
} catch (err) {
  if (String((err as Error).message).includes('duplicate key')) {
    console.error(`user ${email} already exists`);
    process.exit(1);
  }
  throw err;
} finally {
  await pool.end();
}
