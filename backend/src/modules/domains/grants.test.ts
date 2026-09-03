/**
 * The permission model, as a table.
 *
 * Domain control has three independent gates — what the driver can do, what
 * this install was granted, and what the mail server itself permits — and the
 * only thing that matters is that no two surfaces disagree about the answer.
 * The UI greys out a switch on it, the CLI prints it, and the service refuses
 * on it.
 *
 * The cases that matter are the asymmetric ones: a grant this install holds
 * that the server does not, and the reverse. Both must come out closed. The
 * second is the easy one to get wrong, because a server that permits more than
 * was asked for looks like good news right up until an install starts doing
 * things nobody turned on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DOMAIN_GRANTS, type DomainGrant } from '../../contract/types.ts';
import { effectiveGrants, LOCALPART_RE } from './grants.ts';

const ALL = DOMAIN_GRANTS;

test('a grant is effective only when all three gates allow it', () => {
  const cases: Array<{
    why: string;
    grants: DomainGrant[];
    server: DomainGrant[];
    capable: DomainGrant[];
    expect: DomainGrant[];
  }> = [
    {
      why: 'everything agrees',
      grants: ['list', 'create'],
      server: ['list', 'create'],
      capable: ALL,
      expect: ['list', 'create'],
    },
    {
      why: 'granted here, refused by the server',
      grants: ['list', 'create', 'delete'],
      server: ['list', 'create'],
      capable: ALL,
      expect: ['list', 'create'],
    },
    {
      why: 'the server permits more than was granted — the extra stays off',
      grants: ['list'],
      server: ALL,
      capable: ALL,
      expect: ['list'],
    },
    {
      why: 'the driver cannot do it, whatever the other two say',
      grants: ['list', 'alias'],
      server: ['list', 'alias'],
      capable: ['list', 'create'],
      expect: ['list'],
    },
    {
      why: 'never probed, so the server has said nothing yet',
      grants: ALL,
      server: [],
      capable: ALL,
      expect: [],
    },
    { why: 'nothing granted', grants: [], server: ALL, capable: ALL, expect: [] },
  ];

  for (const c of cases) {
    assert.deepEqual(effectiveGrants(c.grants, c.server, c.capable), c.expect, c.why);
  }
});

test('the result follows the granted order, so a rendered list is stable', () => {
  assert.deepEqual(effectiveGrants(['delete', 'list', 'create'], ALL, ALL), [
    'delete',
    'list',
    'create',
  ]);
});

/**
 * The same shape the helper enforces on the mail server, checked here so a
 * mistake is a sentence in the UI rather than a refusal three hops away. These
 * two have to stay in step: a localpart this accepts and the helper rejects is
 * a create that fails after the operator typed a password.
 */
test('accepts the localparts a mail server will accept', () => {
  for (const ok of ['a', 'a1', 'hello', 'no-reply', 'first.last', 'a_b', 'x+tag', 'a.b-c_d1']) {
    assert.equal(LOCALPART_RE.test(ok), true, ok);
  }
});

test('refuses every localpart that would surprise a shell, a map, or a passwd file', () => {
  for (const bad of [
    '',
    '.leading',
    'trailing.',
    '-leading',
    'trailing-',
    'Upper',
    'has space',
    'semi;colon',
    'quote"d',
    "tick'd",
    'back\\slash',
    'pipe|d',
    'dollar$',
    'back`tick',
    'new\nline',
    'colon:in',
    'at@sign',
    'slash/es',
    '../../etc/shadow',
    'a'.repeat(65),
  ]) {
    assert.equal(LOCALPART_RE.test(bad), false, JSON.stringify(bad));
  }
});
