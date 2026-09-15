import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpConfigs, serverEntry } from '../src/hosts/mcp-config.js';

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
  for (const id of ['grok', 'muse', 'antigravity']) assert.deepEqual(registerMcpConfigs(repo, [id], { home }), []);
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
