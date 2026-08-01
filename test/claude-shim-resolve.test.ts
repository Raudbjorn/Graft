/**
 * The shim's resolution behaviour, exercised by actually running it.
 *
 * This is the regression test for the "installed graft once, still on the old
 * version" report: the shim used to take the FIRST candidate that existed. On
 * a machine with more than one graft install reachable (an nvm switch, a
 * stale global copy) the first one found could easily be the old one, and
 * `npm i -g @nanonets/graft@latest` upgraded a directory the shim never
 * looked at again. The shim now takes the highest-versioned candidate
 * instead — see `best()`/`versionOf()` in shim-template.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hooksShim } from '../src/claude/shim-template.js';
import { tmpRepo } from './helpers.js';

/** A fake installed @nanonets/graft whose hooks entry records that it ran. */
function fakeInstall(root: string, name: string, version: string): string {
  const pkg = join(root, name);
  const distClaude = join(pkg, 'dist', 'claude');
  mkdirSync(distClaude, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@nanonets/graft', version }));
  // CJS on purpose: no "type" field, so `import()` hands back module.exports and
  // `m.main(...)` resolves — same shape the real dist has for the shim's call.
  writeFileSync(
    join(distClaude, 'hooks.js'),
    `module.exports.main = () => require('node:fs').writeFileSync(process.env.MARKER, ${JSON.stringify(version)});\n`,
  );
  return distClaude;
}

/** Runs the shim against `projectDir`; returns the version of the install
 * that actually got loaded (or null if none did). */
function runShim(root: string, projectDir: string): string | null {
  const shimPath = join(root, 'graft-hooks.cjs');
  const marker = join(root, 'loaded.txt');
  writeFileSync(shimPath, hooksShim());
  const res = spawnSync(process.execPath, [shimPath, 'session-start'], {
    encoding: 'utf8',
    env: { ...process.env, MARKER: marker, CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
  return existsSync(marker) ? readFileSync(marker, 'utf8') : null;
}

/** Installs a fake graft at `<projectDir>/node_modules/@nanonets/graft` — the
 * repo node_modules candidate (`fromPkg(dir)`, checked first). */
function fakeRepoInstall(projectDir: string, version: string): void {
  fakeInstall(join(projectDir, 'node_modules', '@nanonets'), 'graft', version);
}

// The fakes' versions sit far above any real release ON PURPOSE: the shim's
// candidate list also includes the node install the TEST RUNNER itself lives
// under (`process.execPath`/../lib) and the global `npm root -g` dir, so on a
// machine with a real `npm i -g` graft that real install could join the race
// and outrank a realistic-looking fake — the shim would correctly load it,
// the fake marker would never land, and the test would report a resolution
// the fixture never contained. Absurdly high fake versions win regardless.
const WINNER = '99.0.0';

test('the repo node_modules install is found and used', () => {
  const root = tmpRepo('shim-repo-install');
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  fakeRepoInstall(projectDir, WINNER);
  assert.equal(runShim(root, projectDir), WINNER);
});

test('no candidate at all exits quietly — a hook must never fail the session', () => {
  const root = tmpRepo('shim-none');
  const projectDir = join(root, 'project', 'unrelated-empty-dir');
  mkdirSync(projectDir, { recursive: true });
  // No node_modules under projectDir, so the repo candidate misses; whether the
  // shim finds nothing or (on a dev machine with graft installed globally)
  // finds the real thing, it must not crash either way.
  const res = spawnSync(process.execPath, [(() => {
    const shimPath = join(root, 'graft-hooks.cjs');
    writeFileSync(shimPath, hooksShim());
    return shimPath;
  })(), 'session-start'], {
    encoding: 'utf8',
    env: { ...process.env, MARKER: join(root, 'loaded.txt'), CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
});
