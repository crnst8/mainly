/** Fail the build on known-vulnerable dependencies, across all three workspaces.
 *
 * `npm audit` is run twice per workspace: once over the full tree and once with
 * `--omit=dev`. Anything in the first run but not the second is dev-only — it
 * ships on a build machine, not in the runtime image, so it is held to a lower
 * bar. Runtime dependencies fail at high; dev-only ones only at critical.
 *
 * That split is the whole point. A gate that fails every open PR because a
 * transitive dev advisory landed overnight is a gate someone deletes, and then
 * the runtime ones stop being caught too.
 *
 * Exceptions live in .github/audit-allowlist.json and must carry a reason and
 * an expiry, so "we looked at this and it is not reachable" cannot quietly
 * become "nobody has looked at this since 2024".
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WORKSPACES = ['backend', 'frontend', 'mcp'];
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const FAIL_AT_RUNTIME = RANK.high;
const FAIL_AT_DEV = RANK.critical;

const ALLOWLIST = new URL('../.github/audit-allowlist.json', import.meta.url);
const today = new Date().toISOString().slice(0, 10);

/* npm audit exits nonzero when it finds anything, which is not an error here. */
const audit = async (cwd, extra = []) => {
  const args = ['audit', '--json', '--audit-level=none', ...extra];
  try {
    const { stdout } = await run('npm', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* fall through to the rethrow below */
      }
    }
    throw new Error(`npm audit failed in ${cwd}: ${err.stderr || err.message}`);
  }
};

/* One row per (workspace, advisory), which is the unit a human triages. Walking
   `via` reaches the advisory that actually names a GHSA id; a package whose only
   `via` entries are strings is collateral from a dependency's advisory, and is
   reported under that advisory rather than on its own. */
const advisories = (report, workspace, devOnly) => {
  const out = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (typeof via === 'string' || !via.url) continue;
      const id = via.url.split('/').pop();
      const existing = out.get(id);
      if (existing) {
        existing.packages.add(vuln.name);
        continue;
      }
      out.set(id, {
        id,
        workspace,
        devOnly,
        severity: via.severity ?? 'unknown',
        title: via.title ?? via.name,
        url: via.url,
        range: via.range,
        packages: new Set([vuln.name]),
        fix: vuln.fixAvailable,
      });
    }
  }
  return out;
};

const allowlist = await readFile(ALLOWLIST, 'utf8')
  .then((raw) => JSON.parse(raw))
  .catch((err) => {
    if (err.code === 'ENOENT') return { allow: [] };
    throw new Error(`.github/audit-allowlist.json is not valid JSON: ${err.message}`);
  });

const allowed = new Map((allowlist.allow ?? []).map((e) => [e.id, e]));
const used = new Set();

const found = [];
for (const workspace of WORKSPACES) {
  const cwd = new URL(`../${workspace}/`, import.meta.url).pathname;
  const [full, prod] = await Promise.all([audit(cwd), audit(cwd, ['--omit=dev'])]);
  const runtime = advisories(prod, workspace, false);
  for (const [id, adv] of advisories(full, workspace, true)) {
    found.push(runtime.get(id) ?? adv);
  }
}

const fixCommand = (adv) => {
  const pkgs = [...adv.packages].join(' ');
  if (adv.fix && typeof adv.fix === 'object') {
    const major = adv.fix.isSemVerMajor ? '  # major bump, read the changelog' : '';
    return `(cd ${adv.workspace} && npm install ${adv.fix.name}@^${adv.fix.version})${major}`;
  }
  return `(cd ${adv.workspace} && npm update ${pkgs})`;
};

const blocking = [];
const warnings = [];
let belowThreshold = 0;

for (const adv of found.sort((a, b) => RANK[b.severity] - RANK[a.severity])) {
  const rank = RANK[adv.severity] ?? RANK.high;
  const waiver = allowed.get(adv.id);

  if (waiver) {
    used.add(adv.id);
    if (waiver.expires && waiver.expires < today) {
      blocking.push({ adv, why: `waiver expired ${waiver.expires} — re-check or bump` });
    } else {
      warnings.push({ adv, why: `waived until ${waiver.expires ?? 'forever'}: ${waiver.reason}` });
    }
    continue;
  }

  const threshold = adv.devOnly ? FAIL_AT_DEV : FAIL_AT_RUNTIME;
  const entry = { adv, why: adv.devOnly ? 'build-time dependency' : 'ships in the runtime image' };
  if (rank >= threshold) blocking.push(entry);
  else if (rank >= RANK.high) warnings.push(entry);
  else belowThreshold++;
}

const show = (label, rows) => {
  if (!rows.length) return;
  console.log(`\n${label}\n`);
  for (const { adv, why } of rows) {
    console.log(`  ${adv.severity.padEnd(8)} ${adv.workspace}  ${[...adv.packages].join(', ')}`);
    console.log(`           ${adv.title}`);
    console.log(`           ${adv.url}  (${why})`);
    console.log(`           fix: ${fixCommand(adv)}`);
    console.log('');
  }
};

show('Warnings (not blocking):', warnings);
show('Blocking vulnerabilities:', blocking);

/* Counted rather than listed. Below high is not something to act on today, but
   it should not be invisible either - `npm audit` in the workspace has details. */
if (belowThreshold) {
  console.log(`\n${belowThreshold} advisory(s) below the high threshold - see \`npm audit\`.`);
}

const stale = [...allowed.keys()].filter((id) => !used.has(id));
if (stale.length) {
  console.log(
    `\nStale waivers in .github/audit-allowlist.json — the advisory is gone, ` +
      `delete the entry:\n  ${stale.join('\n  ')}\n`,
  );
}

if (blocking.length) {
  console.error(
    `audit-check: ${blocking.length} blocking, ${warnings.length} warning across ` +
      `${WORKSPACES.length} workspaces.\n` +
      'Bump the dependency, or add a waiver with a reason and an expiry to ' +
      '.github/audit-allowlist.json.',
  );
  process.exit(1);
}

console.log(
  `audit-check: clean (${warnings.length} warning) across ${WORKSPACES.join(', ')}.`,
);
