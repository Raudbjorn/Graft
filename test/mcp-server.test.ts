import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startMcpServer } from '../src/mcp/server.js';
import { acquireLockIn, releaseLockIn } from '../src/util/state.js';
import { ToolPool } from '../src/mcp/pool.js';

const token = 'test-token-only';
const headers = { Authorization: `Bearer ${token}` };
function text(result: any): string { return result.content[0].text; }

async function connect(url: string) {
  const client = new Client({ name: 'graft-test', version: '1.0.0' });
  const events: any[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, message => { events.push(message.params.data); });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return { client, transport, events };
}

test('HTTP discovery, explicit builds, shared builds, scoped SSE notifications and refresh', { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-'));
  const other = mkdtempSync(join(tmpdir(), 'graft-http-other-'));
  const alias = `${root}-alias`;
  symlinkSync(root, alias, 'dir');
  const server = await startMcpServer({ port: 0, token, version: '1.0.0', idleMs: 200 });
  const a = await connect(server.url), b = await connect(server.url), c = await connect(server.url);
  t.after(async () => {
    await Promise.all([a, b, c].map(async x => { await x.transport.terminateSession(); await x.client.close(); }));
    await server.close();
    for (const dir of [root, other, alias]) rmSync(dir, { recursive: true, force: true });
  });
  const list = await a.client.listTools();
  assert.equal(list.tools.length, 7);
  for (const tool of list.tools) assert.ok(tool.inputSchema.required?.includes('project_root'));
  assert.match(a.client.getInstructions()!, /project_root/);
  assert.ok(a.client.getInstructions()!.length < 1100);
  for (const tool of list.tools) assert.ok(a.client.getInstructions()!.includes(tool.name));
  const missing = await a.client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /graft_build/);
  assert.equal(existsSync(join(root, 'graft', '.graph', 'wiring.json')), false);
  await b.client.callTool({ name: 'graft_repo_map', arguments: { project_root: alias } });
  await c.client.callTool({ name: 'graft_repo_map', arguments: { project_root: other } });
  writeFileSync(join(root, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  // Hold the cross-process lock so both requests join the same build before it starts.
  const cache = join(root, 'graft', '.cache');
  assert.ok(acquireLockIn(cache));
  const first = a.client.callTool({ name: 'graft_build', arguments: { project_root: root } });
  const second = b.client.callTool({ name: 'graft_build', arguments: { project_root: alias, context_dir: join(root, 'graft') } });
  await delay(150);
  // A waiting build must not block another repository or the protocol loop.
  await c.client.ping();
  assert.equal((await c.client.callTool({ name: 'graft_repo_map', arguments: { project_root: other } })).isError, true);
  releaseLockIn(cache);
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.isError, false, text(r1));
  assert.equal(text(r1), text(r2));
  const built = JSON.parse(text(r1));
  assert.ok(existsSync(built.graph_path));
  assert.ok(existsSync(join(root, 'graft', 'INDEX.md')));
  await delay(100);
  assert.equal(a.events.filter(e => e.status === 'completed').length, 1);
  assert.equal(b.events.filter(e => e.status === 'completed').length, 1);
  assert.equal(c.events.length, 0);
  writeFileSync(join(root, 'math.ts'), 'export function multiply(a: number, b: number) { return a * b; }\n');
  const query = await a.client.callTool({ name: 'graft_find_all', arguments: { project_root: root, pattern: 'multiply' } });
  assert.equal(query.isError, false, text(query));
  assert.match(text(query), /multiply/);
  await delay(100);
  assert.equal(b.events.filter(e => e.status === 'completed').length, 2);
  const custom = join(other, 'custom', 'graph');
  writeFileSync(join(other, 'hello.ts'), 'export function hello() { return 42; }\n');
  const customBuild = await c.client.callTool({ name: 'graft_build', arguments: { project_root: other, context_dir: custom } });
  assert.equal(customBuild.isError, false, text(customBuild));
  assert.equal(JSON.parse(text(customBuild)).context_dir, custom);
  assert.match(text(await c.client.callTool({ name: 'graft_find_all', arguments: { project_root: other, context_dir: custom, pattern: 'hello' } })), /hello/);
  await delay(300); // idle worker reclamation must allow a subsequent fresh worker
  assert.equal((await a.client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } })).isError, false);
});

test('HTTP rejects unauthenticated, malformed and unsafe requests; sessions terminate', async t => {
  const server = await startMcpServer({ port: 0, token });
  t.after(() => server.close());
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal(await new Promise<number | undefined>((resolve, reject) => {
    request(server.url, { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  }), 403);
  assert.equal((await fetch(server.url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(server.url, { method: 'PUT', headers })).status, 405);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: ' '.repeat(1_048_577) })).status, 413);
  const { client, transport } = await connect(server.url);
  const missing = await client.callTool({ name: 'graft_repo_map', arguments: {} });
  assert.equal(missing.isError, true);
  const invalid = await client.callTool({ name: 'graft_find_all', arguments: { project_root: '.', pattern: 123 } });
  assert.equal(invalid.isError, true);
  const id = transport.sessionId!;
  await transport.terminateSession();
  await client.close();
  assert.equal((await fetch(server.url, { headers: { ...headers, 'mcp-session-id': id } })).status, 404);
});

test('worker crash fails its request and the pool recovers; shutdown reaps workers', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-worker-'));
  const pool = new ToolPool(1, 50);
  t.after(async () => { await pool.close(); rmSync(root, { recursive: true, force: true }); });
  const cache = join(root, 'graft', '.cache');
  acquireLockIn(cache);
  const result = pool.run(root, 'graft_build', {}, undefined, () => {});
  const rejected = assert.rejects(result, /worker exited/);
  (pool as any).slots[0].child.kill('SIGKILL');
  await rejected;
  releaseLockIn(cache);
  const retry = await pool.run(root, 'graft_repo_map', {}, undefined, () => {});
  assert.equal(retry.isError, true);
  const children = (pool as any).slots.map((s: any) => s.child);
  await pool.close();
  for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
});


test('workspace builds keep child graphs separate and preserve custom output files', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-workspace-'));
  for (const name of ['one', 'two']) {
    const child = join(root, name);
    mkdirSync(child);
    execFileSync('git', ['init', '-q', child]);
    writeFileSync(join(child, 'index.ts'), `export function ${name}() { return 1; }\n`);
  }
  const out = join(root, 'output');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'user data');
  const server = await startMcpServer({ port: 0, token });
  const { client, transport } = await connect(server.url);
  t.after(async () => { await transport.terminateSession(); await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const result = await client.callTool({ name: 'graft_build', arguments: { project_root: root, context_dir: out } });
  assert.equal(result.isError, false, text(result));
  const built = JSON.parse(text(result));
  assert.equal(built.children.length, 2);
  for (const child of built.children) assert.ok(existsSync(child.graph_path));
  assert.ok(existsSync(join(out, 'keep.txt')), 'workspace build must not delete unrelated files');
  assert.ok(existsSync(built.graph_path));
  const query = await client.callTool({ name: 'graft_find_all', arguments: { project_root: root, context_dir: out, pattern: 'function' } });
  assert.equal(query.isError, false, text(query));
  assert.match(text(query), /one/);
  assert.match(text(query), /two/);
});


test('a worker killed while holding a build lock leaves no stale lock', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-worker-lock-'));
  writeFileSync(join(root, 'index.ts'), 'export function ready() { return 1; }\n');
  const pool = new ToolPool(1);
  t.after(async () => { await pool.close(); rmSync(root, { recursive: true, force: true }); });
  const result = pool.run(root, 'graft_build', {}, undefined, event => {
    if (event.status === 'started') (pool as any).slots[0].child.kill('SIGKILL');
  });
  await assert.rejects(result, /worker exited/);
  assert.equal(existsSync(join(root, 'graft', '.cache', '.sync.lock')), false);
  assert.equal((await pool.run(root, 'graft_build', {}, undefined, () => {})).isError, false);
});
