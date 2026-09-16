import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyStats, readStats, writeStats, patchStats,
  readSession, writeSession, acquireLock, releaseLock, cacheDir, LOCK_STALE_MS, writeJsonAtomic,
} from '../src/claude/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-state-')); }

test('stats round-trip and patch merge', () => {
  const d = fresh();
  assert.equal(readStats(d), null);
  writeStats(d, { ...emptyStats(), nodeCount: 319, edgeCount: 730 });
  assert.equal(readStats(d)!.nodeCount, 319);
  const patched = patchStats(d, { dirty: true, staleCount: 4 });
  assert.equal(patched.dirty, true);
  assert.equal(patched.staleCount, 4);
  assert.equal(readStats(d)!.edgeCount, 730, 'patch preserves other fields');
});

test('session defaults and round-trip', () => {
  const d = fresh();
  const s = readSession(d, 'abc');
  assert.deepEqual(s, { lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 });
  s.lastQuery = 'pkce'; s.graftReads = 2;
  writeSession(d, 'abc', s);
  assert.equal(readSession(d, 'abc').lastQuery, 'pkce');
  assert.equal(readSession(d, 'xyz').graftReads, 0, 'other sessions isolated');
});

test('lock is exclusive then releasable', () => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false, 'second acquire blocked while held');
  assert.ok(existsSync(join(cacheDir(d), '.sync.lock')));
  releaseLock(d);
  assert.equal(acquireLock(d), true, 'reacquire after release');
});

test('acquireLock reclaims a stale lock only after its owner exits', t => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  const p = join(cacheDir(d), '.sync.lock');
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(p, old, old);
  const verifiable = Boolean(JSON.parse(readFileSync(p, 'utf8')).identity);
  assert.equal(acquireLock(d), !verifiable, 'verified live owners retain locks; unverifiable owners have an age cap');
  writeFileSync(p, JSON.stringify({ pid: 2147483647 }));
  utimesSync(p, old, old);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  assert.equal(acquireLock(d), true, 'dead owner lock reclaimed');
});

test('writeJsonAtomic leaves no scratch file behind when the write fails', () => {
  const d = fresh();
  const dir = join(d, 'locked');
  mkdirSync(dir, { recursive: true });

  // The failure is injected by putting a *directory* where the file belongs, so the
  // rename fails. This replaces a read-only parent dir (`chmod 0o500`), which was
  // both non-portable — Windows ignores it, and so does root, hence the skip this
  // test used to carry — and weaker: the tmp file was never created there, so there
  // was never anything that could have been left behind. Here it definitely is.
  const target = join(dir, 'out.json');
  mkdirSync(target);

  // Every CLI invocation is a new pid, so a repeatedly failing write would leave one
  // full-size `<path>.<pid>.tmp` per attempt, and nothing in graft ever lists these
  // directories to clean them up — on a nearly-full disk that accelerates the ENOSPC
  // that caused it.
  assert.throws(() => writeJsonAtomic(target, { pad: 'x'.repeat(1024) }));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'no .tmp residue',
  );
});


test('PID reuse, foreign hosts and legacy owners cannot keep locks forever', () => {
  const d = fresh();
  assert.ok(acquireLock(d));
  const path = join(cacheDir(d), '.sync.lock');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  if (owner.identity) {
    writeFileSync(path, JSON.stringify({ ...owner, identity: `${owner.identity}-old-instance` }));
    assert.ok(acquireLock(d), 'a reused live PID is a different process instance');
  }
  for (const old of [{ pid: process.pid }, { ...owner, host: 'another-host' }]) {
    writeFileSync(path, JSON.stringify(old));
    assert.equal(acquireLock(d), false, 'fresh unverifiable locks retain their grace period');
    const at = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(path, at, at);
    assert.ok(acquireLock(d), 'unverifiable locks have an absolute age cap');
  }
});
