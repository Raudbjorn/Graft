import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the MCP launch form so expectations don't depend on whether the machine
// running the tests happens to have graft on PATH.
process.env.GRAFT_MCP_NPX = '1';

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMuseHooks, museHookTargets } from '../src/hosts/muse-hooks.js';
import { runHostsInit } from '../src/hosts/init.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-musehooks-')); }

const HAS_EXEC_BIT = process.platform !== 'win32';
function assertRunnableShim(shim: string, note: string): void {
  assert.ok(existsSync(shim), `${note}: shim missing at ${shim}`);
  if (HAS_EXEC_BIT) assert.ok(statSync(shim).mode & 0o111, note);
}

const shimPath = (repo: string) => join(repo, '.muse', 'hooks', 'graft-hooks.cjs');
const cfgPath = (repo: string) => join(repo, '.muse', 'hooks.json');
const mcpPath = (home: string) => join(home, '.config', 'muse', 'settings.json');

test('museHookTargets are repo-local and always present (no CLI-home gate)', () => {
  const repo = fresh();
  const t = museHookTargets(repo);
  assert.equal(t.length, 2);
  assert.ok(t.every((w) => w.scope === 'repo' && w.hostId === 'muse'));
  assert.deepEqual(t.map((w) => w.path).sort(), [cfgPath(repo), shimPath(repo)].sort());
});

test('writes shim + nested hooks.json, idempotent on re-run', () => {
  const repo = fresh();
  const w = installMuseHooks(repo);
  assert.equal(w.length, 2);
  assertRunnableShim(shimPath(repo), 'shim is executable');
  const cfg = JSON.parse(readFileSync(cfgPath(repo), 'utf8'));
  // Claude-settings nesting: events live under a top-level `hooks` key —
  // the flat shape never fires in Muse (verified against the live binary).
  const hooks = cfg.hooks;
  assert.ok(hooks && typeof hooks === 'object', 'events nested under hooks');
  const post = hooks.PostToolUse;
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Write|Edit');
  assert.match(post[0].hooks[0].command, /graft-hooks\.cjs" post-edit$/);
  assert.equal(post[0].hooks[0].type, 'command');
  const start = hooks.SessionStart;
  assert.equal(start.length, 1);
  assert.match(start[0].hooks[0].command, /graft-hooks\.cjs" session-start$/);
  assert.ok(!('matcher' in start[0]), 'no matcher on SessionStart');

  const again = installMuseHooks(repo);
  assert.deepEqual(again.map((x) => x.action), ['unchanged', 'unchanged'], 'idempotent');
  const after = JSON.parse(readFileSync(cfgPath(repo), 'utf8'));
  assert.equal(after.hooks.PostToolUse.length, 1, 'not duplicated on re-run');
  assert.equal(after.hooks.SessionStart.length, 1, 'not duplicated on re-run');
});

test('foreign hook entries are preserved; stale graft entries replaced', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.muse'), { recursive: true });
  writeFileSync(cfgPath(repo), JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'other-tool.sh' }] },
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node /old/graft-hooks.cjs post-edit' }] },
      ],
    },
  }));
  installMuseHooks(repo);
  const entries = JSON.parse(readFileSync(cfgPath(repo), 'utf8')).hooks.PostToolUse;
  assert.equal(entries.length, 2, 'foreign kept, stale graft replaced by fresh');
  assert.ok(entries.some((e: any) => e.hooks[0].command === 'other-tool.sh'), 'foreign entry preserved');
  assert.ok(entries.some((e: any) => /graft-hooks\.cjs" post-edit$/.test(e.hooks[0].command)), 'fresh graft entry present');
  assert.ok(!JSON.stringify(entries).includes('/old/'), 'stale graft entry removed');
});

test('unparseable hooks.json is never rewritten', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.muse'), { recursive: true });
  writeFileSync(cfgPath(repo), '{ nope');
  const w = installMuseHooks(repo);
  assert.ok(w.some((x) => x.action === 'skipped-unparseable'));
  assert.equal(readFileSync(cfgPath(repo), 'utf8'), '{ nope');
});

test('wrong-shaped hooks (hooks is not an object) is never rewritten', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.muse'), { recursive: true });
  writeFileSync(cfgPath(repo), JSON.stringify({ hooks: [] }));
  const w = installMuseHooks(repo);
  assert.ok(w.some((x) => x.action === 'skipped-unparseable'));
  assertRunnableShim(shimPath(repo), 'shim still written');
});

// ── runHostsInit wiring ─────────────────────────────────────────────────────

test('runHostsInit --agents muse writes repo hooks + user-level MCP (mcpServers, schema_version)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['muse'] });
  assert.ok(existsSync(cfgPath(repo)), 'hooks.json written in the repo');
  assert.ok(existsSync(shimPath(repo)), 'shim written in the repo');
  assert.ok(r.hooks.some((h) => h.id === 'muse-hooks'), 'reported in result.hooks');
  assert.ok(existsSync(join(repo, 'AGENTS.md')), 'instruction section written');
  // MCP is user-level: the camelCase key and the mandatory schema version.
  const mcp = r.mcp.find((m) => m.id === 'muse');
  assert.ok(mcp, 'muse MCP write reported');
  assert.equal(mcp.path, mcpPath(home));
  const settings = JSON.parse(readFileSync(mcpPath(home), 'utf8'));
  assert.equal(settings.schema_version, 1, 'mandatory schema version present');
  assert.deepEqual(settings.mcpServers.graft, {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@nanonets/graft', 'mcp'],
  });
});

test('existing settings keep their keys; foreign servers and schema survive', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.config', 'muse'), { recursive: true });
  writeFileSync(mcpPath(home), JSON.stringify({
    schema_version: 1,
    mcpServers: { other: { transport: 'stdio', command: 'x' } },
  }));
  const r = runHostsInit(repo, { home, agents: ['muse'] });
  const settings = JSON.parse(readFileSync(mcpPath(home), 'utf8'));
  assert.ok((settings.mcpServers as any).other, 'foreign server preserved');
  assert.ok((settings.mcpServers as any).graft, 'graft server merged');
  const again = runHostsInit(repo, { home, agents: ['muse'] });
  assert.ok(again.mcp.some((m) => m.id === 'muse' && m.action === 'unchanged'), 'idempotent');
});

test('muse hooks are repo-local, so --no-global does NOT suppress them (MCP is)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['muse'], global: false });
  assert.ok(existsSync(cfgPath(repo)), '--no-global keeps the repo-local Muse hooks');
  assert.ok(!existsSync(mcpPath(home)), '--no-global suppresses the user-level MCP write');
  assert.ok(!r.mcp.some((m) => m.id === 'muse'), 'no muse MCP write reported');
});

test('--no-hooks skips the Muse hook files (instruction + MCP still written)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['muse'], hooks: false });
  assert.ok(!existsSync(cfgPath(repo)), 'no hooks.json under --no-hooks');
  assert.ok(!existsSync(shimPath(repo)), 'no shim under --no-hooks');
  assert.ok(!r.hooks.some((h) => h.id?.startsWith('muse')), 'no muse hook writes reported');
  assert.ok(existsSync(join(repo, 'AGENTS.md')), 'the instruction section is still written');
  assert.ok(existsSync(mcpPath(home)), 'the MCP registration is still written');
});

test('--no-mcp skips the settings write (hooks still written)', () => {
  const home = fresh(); const repo = fresh();
  const r = runHostsInit(repo, { home, agents: ['muse'], mcp: false });
  assert.ok(!existsSync(mcpPath(home)), 'no settings.json under --no-mcp');
  assert.ok(r.mcp.length === 0, 'no MCP writes reported');
  assert.ok(existsSync(cfgPath(repo)), 'hooks still written');
});
