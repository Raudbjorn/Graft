// Explicit daemon registration tests opt in with a non-secret test token.
process.env.GRAFT_MCP_TOKEN = 'test-registration-token';
import { test } from 'node:test';
import { planInit } from '../src/hosts/plan.js';
import { planRetract } from '../src/hosts/retract.js';
import { runInit } from '../src/claude/init.js';
import { spawnSync } from 'node:child_process';
import { mcpPort, mcpUrl, jobTimeoutMs } from '../src/mcp/config.js';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpConfigs, serverEntry, mcpTargets } from '../src/hosts/mcp-config.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-mcpcfg-')); }

test('cursor/gemini/kiro get repo-local JSON entries', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['cursor', 'gemini', 'kiro'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created', 'created', 'created']);
  const cursor = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursor.mcpServers.graft, { url: 'http://127.0.0.1:8421/mcp', headers: { Authorization: 'Bearer ${env:GRAFT_MCP_TOKEN}' } });
  assert.ok(existsSync(join(repo, '.gemini', 'settings.json')));
  assert.ok(existsSync(join(repo, '.kiro', 'settings', 'mcp.json')));
});

test('existing config keys are preserved; re-run is unchanged', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, graft: { command: 'old', args: ['mcp'], disabled: true, autoApprove: ['graft_repo_map'] } } }));
  registerMcpConfigs(repo, ['cursor'], { home });
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other, 'foreign server preserved');
  assert.ok(cfg.mcpServers.graft);
  assert.equal(cfg.mcpServers.graft.disabled, true);
  assert.deepEqual(cfg.mcpServers.graft.autoApprove, ['graft_repo_map']);
  assert.equal(cfg.mcpServers.graft.command, undefined);
  const again = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('unparseable JSON is never clobbered', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), '{ not json');
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
});

test('agents id: codex TOML + opencode JSON, gated on home dirs', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }), [], 'nothing without home dirs');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const w = registerMcpConfigs(repo, ['agents'], { home });
  assert.equal(w.length, 2);
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /bearer_token_env_var = "GRAFT_MCP_TOKEN"/);
  const oc = JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.graft.type, 'remote');
  const again = registerMcpConfigs(repo, ['agents'], { home });
  assert.deepEqual(again.map((x) => x.action).sort(), ['unchanged', 'unchanged']);
});

test('codex TOML append preserves existing content', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  registerMcpConfigs(repo, ['agents'], { home });
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.graft\]/);
});

test('unverified HTTP hosts leave existing configuration alone', () => {
  const repo = fresh(); const home = fresh();
  for (const id of ['grok', 'muse', 'antigravity']) {
    const [result] = registerMcpConfigs(repo, [id], { home });
    assert.equal(result.action, 'skipped');
    assert.match((result as any).reason, /preserved/);
  }
  assert.ok(!existsSync(join(repo, '.grok', 'config.toml')));
  assert.ok(!existsSync(join(home, '.config', 'muse', 'settings.json')));
});

test('droid gets a repo-local .factory/mcp.json; pi and project-agents get nothing', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['droid', 'pi', 'project-agents'], { home });
  assert.deepEqual(w.map((x) => x.id).sort(), ['droid'], 'pi registers no MCP config at all');
  const droid = JSON.parse(readFileSync(join(repo, '.factory', 'mcp.json'), 'utf8'));
  assert.deepEqual(droid.mcpServers.graft, serverEntry());
  const again = registerMcpConfigs(repo, ['droid'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('JSON with non-object mcpServers value is skipped', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  const badJson = '{"mcpServers": "not-an-object"}';
  writeFileSync(join(repo, '.cursor', 'mcp.json'), badJson);
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), badJson);
});

test('HTTP entry keeps secrets out of configuration and supports a custom URL', () => {
  const saved = process.env.GRAFT_MCP_URL;
  try {
    process.env.GRAFT_MCP_URL = 'http://127.0.0.1:9000/mcp';
    assert.deepEqual(serverEntry(), { type: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer ${GRAFT_MCP_TOKEN}' } });
  } finally {
    if (saved === undefined) delete process.env.GRAFT_MCP_URL; else process.env.GRAFT_MCP_URL = saved;
  }
});

test('registration without a token preserves both stdio and HTTP credentials', () => {
  const repo = fresh(), home = fresh();
  const saved = process.env.GRAFT_MCP_TOKEN;
  delete process.env.GRAFT_MCP_TOKEN;
  try {
    mkdirSync(join(repo, '.cursor'));
    const path = join(repo, '.cursor', 'mcp.json');
    const existing = { mcpServers: { graft: { url: 'http://localhost:9000/mcp', headers: { Authorization: 'custom' } }, foreign: {} } };
    writeFileSync(path, JSON.stringify(existing));
    assert.equal(registerMcpConfigs(repo, ['cursor'], { home })[0].action, 'skipped');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), existing);
    existing.mcpServers.graft = { command: 'graft', args: ['mcp'] } as any;
    writeFileSync(path, JSON.stringify(existing));
    registerMcpConfigs(repo, ['cursor'], { home });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), existing);
    registerMcpConfigs(repo, ['gemini'], { home });
    assert.equal(existsSync(join(repo, '.gemini', 'settings.json')), false);
  } finally { if (saved !== undefined) process.env.GRAFT_MCP_TOKEN = saved; }
});

test('selected unsupported hosts preserve legacy and foreign entries', () => {
  const repo = fresh(), home = fresh();
  const paths = [join(home, '.config', 'muse', 'settings.json'), join(home, '.gemini', 'config', 'mcp_config.json')];
  for (const path of paths) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { graft: { command: 'graft', args: ['mcp'] }, foreign: {} } }));
  }
  mkdirSync(join(repo, '.grok'));
  writeFileSync(join(repo, '.grok', 'config.toml'), '[mcp_servers.graft]\ncommand = "graft"\nargs = ["mcp"]\n\n[mcp_servers.foreign]\ncommand = "other"\n');
  registerMcpConfigs(repo, ['muse', 'antigravity', 'grok'], { home });
  for (const path of paths) assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { graft: { command: 'graft', args: ['mcp'] }, foreign: {} } });
  assert.match(readFileSync(join(repo, '.grok', 'config.toml'), 'utf8'), /mcp_servers.graft/);
  assert.match(readFileSync(join(repo, '.grok', 'config.toml'), 'utf8'), /mcp_servers.foreign/);
});

test('daemon URL rejects remote origins and credential-bearing URLs', () => {
  const saved = process.env.GRAFT_MCP_URL;
  try {
    for (const url of ['https://evil.example/mcp', 'http://evil.example/mcp', 'http://user:secret@localhost/mcp', 'http://localhost/mcp?token=x', 'http://localhost/mcp#x', 'http://127.0.0.1:0/mcp']) {
      process.env.GRAFT_MCP_URL = url;
      assert.throws(serverEntry, /loopback/);
    }
  } finally { if (saved === undefined) delete process.env.GRAFT_MCP_URL; else process.env.GRAFT_MCP_URL = saved; }
});

test('legacy OpenCode command arrays are replaced only with a configured token', () => {
  const repo = fresh(), home = fresh();
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const path = join(repo, 'opencode.json');
  writeFileSync(path, JSON.stringify({ mcp: { graft: { type: 'local', command: ['npx', '-y', '@nanonets/graft', 'mcp'] }, foreign: {} } }));
  const saved = process.env.GRAFT_MCP_TOKEN;
  delete process.env.GRAFT_MCP_TOKEN;
  try {
    const result = registerMcpConfigs(repo, ['agents'], { home });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcp.graft.command, ['npx', '-y', '@nanonets/graft', 'mcp']);
    assert.equal(result[0].action, 'skipped');
    assert.match((result[0] as any).reason, /GRAFT_MCP_TOKEN/);
    process.env.GRAFT_MCP_TOKEN = 'test-registration-token';
    registerMcpConfigs(repo, ['agents'], { home });
    const migrated = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(migrated.mcp.graft.type, 'remote');
    assert.equal(migrated.mcp.graft.command, undefined);
    assert.deepEqual(migrated.mcp.foreign, {});
  } finally { if (saved !== undefined) process.env.GRAFT_MCP_TOKEN = saved; }
});


test('invalid daemon URL cannot break planning, retraction or --no-mcp init', () => {
  const repo = fresh(), home = fresh(), saved = process.env.GRAFT_MCP_URL;
  process.env.GRAFT_MCP_URL = 'invalid';
  try {
    assert.doesNotThrow(() => mcpTargets(repo, ['cursor'], { home }));
    assert.doesNotThrow(() => planInit(repo, { home }));
    assert.doesNotThrow(() => planRetract(repo, { home }));
    assert.doesNotThrow(() => runInit(repo, { build: false, mcp: false, global: false, home }));
    assert.throws(() => registerMcpConfigs(repo, ['cursor'], { home }), /Invalid URL/);
  } finally { if (saved === undefined) delete process.env.GRAFT_MCP_URL; else process.env.GRAFT_MCP_URL = saved; }
});


test('daemon address and configurable timeout share validated environment settings', () => {
  const url = process.env.GRAFT_MCP_URL, timeout = process.env.GRAFT_MCP_JOB_TIMEOUT_MS;
  try {
    process.env.GRAFT_MCP_URL = 'http://localhost:9000/mcp';
    assert.equal(mcpPort(), 9000);
    assert.equal(mcpUrl(), 'http://127.0.0.1:9000/mcp');
    process.env.GRAFT_MCP_JOB_TIMEOUT_MS = '600000';
    assert.equal(jobTimeoutMs(), 600000);
    process.env.GRAFT_MCP_JOB_TIMEOUT_MS = '0';
    assert.throws(jobTimeoutMs, /positive/);
  } finally {
    if (url === undefined) delete process.env.GRAFT_MCP_URL; else process.env.GRAFT_MCP_URL = url;
    if (timeout === undefined) delete process.env.GRAFT_MCP_JOB_TIMEOUT_MS; else process.env.GRAFT_MCP_JOB_TIMEOUT_MS = timeout;
  }
});

test('CLI missing-token summary names setup, not --no-mcp', () => {
  const repo = fresh();
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'init', repo, '--agents', 'claude', 'cursor', '--no-build', '--no-global', '--no-hooks', '--no-statusline'], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, GRAFT_MCP_TOKEN: '', GRAFT_TELEMETRY: '0' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /export GRAFT_MCP_TOKEN/);
  assert.doesNotMatch(run.stderr, /registration \(--no-mcp\)/);
  assert.doesNotMatch(run.stderr, /✓ mcp cursor:.*skipped/);
});
