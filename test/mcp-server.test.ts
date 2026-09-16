import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Server as SdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startMcpServer } from '../src/mcp/server.js';
import { acquireLockIn, releaseLockIn } from '../src/util/state.js';
import { readStamp, writeStamp, runningVersion } from '../src/upkeep.js';
import { isTrackedCommand } from '../src/telemetry/contract.js';
import { buildGraph } from '../src/graph/build.js';
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
  // Keep the recovery instruction within the original <1000-character host budget.
  assert.ok(a.client.getInstructions()!.length < 1000);
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
  await buildGraph(root, { contextDir: out });
  assert.ok(existsSync(join(out, '.graph', 'wiring.json')));
  writeFileSync(join(out, 'keep.txt'), 'user data');
  mkdirSync(join(out, '.cache', 'mozilla'), { recursive: true });
  writeFileSync(join(out, '.cache', 'mozilla', 'profile.db'), 'profile');
  writeFileSync(join(out, '.cache', 'paru-pkg.tar'), 'package');
  writeFileSync(join(out, '.graph', 'user.db'), 'foreign graph data');
  writeFileSync(join(out, 'INDEX.md'), 'user index');
  const server = await startMcpServer({ port: 0, token });
  const { client, transport } = await connect(server.url);
  t.after(async () => { await transport.terminateSession(); await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const result = await client.callTool({ name: 'graft_build', arguments: { project_root: root, context_dir: out } });
  assert.equal(result.isError, false, text(result));
  const built = JSON.parse(text(result));
  assert.equal(built.children.length, 2);
  for (const child of built.children) assert.ok(existsSync(child.graph_path));
  assert.equal(existsSync(join(out, '.graph', 'wiring.json')), false, 'remove the obsolete parent graph');
  assert.equal(existsSync(join(out, 'one', 'index.md')), false, 'remove the obsolete parent cards');
  assert.equal(existsSync(join(out, 'one')), false, 'remove empty mirrored directories');
  assert.equal(readFileSync(join(out, '.cache', 'mozilla', 'profile.db'), 'utf8'), 'profile');
  assert.equal(readFileSync(join(out, '.cache', 'paru-pkg.tar'), 'utf8'), 'package');
  assert.equal(readFileSync(join(out, '.graph', 'user.db'), 'utf8'), 'foreign graph data');
  assert.equal(readFileSync(join(out, 'INDEX.md'), 'utf8'), 'user index');
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

test('HTTP seeds a new worktree and accepts the legacy trace file argument', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-seed-'));
  const main = join(root, 'main'), wt = join(root, 'worktree');
  mkdirSync(main); mkdirSync(wt);
  const gitdir = join(main, '.git', 'worktrees', 'test');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
  for (const dir of [main, wt]) writeFileSync(join(dir, 'index.ts'), 'export function seeded() { return 1; }\n');
  const server = await startMcpServer({ port: 0, token });
  const { client, transport } = await connect(server.url);
  t.after(async () => { await transport.terminateSession(); await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await client.callTool({ name: 'graft_build', arguments: { project_root: main } })).isError, false);
  const query = await client.callTool({ name: 'graft_find_all', arguments: { project_root: wt, pattern: 'seeded' } });
  assert.equal(query.isError, false, text(query));
  assert.match(text(query), /seeded/);
  assert.ok(existsSync(join(wt, 'graft', '.graph', 'wiring.json')));
  const trace = await client.callTool({ name: 'graft_trace_calls', arguments: { project_root: wt, file: 'index.ts' } });
  assert.doesNotMatch(text(trace), /required property|symbol.*required/);
  rmSync(join(wt, 'graft'), { recursive: true });
  const build = await client.callTool({ name: 'graft_build', arguments: { project_root: wt } });
  assert.equal(build.isError, false, text(build));
  assert.equal(JSON.parse(text(build)).parsed, 0, 'explicit builds also reuse the parent graph');
});

test('worker deadline releases capacity without removing a foreign build lock', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-timeout-'));
  const cache = join(root, 'graft', '.cache');
  const pool = new ToolPool(1, 100, 1500);
  t.after(async () => { await pool.close(); rmSync(root, { recursive: true, force: true }); });
  assert.ok(acquireLockIn(cache));
  const failures: any[] = [];
  await assert.rejects(pool.run(root, 'graft_build', {}, undefined, event => {
    if (event.status === 'failed') failures.push(event);
    if (event.status === 'progress') (pool as any).slots[0].child.kill('SIGSTOP');
  }), /without progress/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].context_dir, join(root, 'graft'));
  assert.ok(existsSync(join(cache, '.sync.lock')), 'the lock belongs to the test process');
  releaseLockIn(cache);
  assert.equal((await pool.run(root, 'graft_repo_map', {}, undefined, () => {})).isError, true);
});

test('an open SSE stream survives session idle expiry and retains subscriptions', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-idle-'));
  writeFileSync(join(root, 'index.ts'), 'export const alive = 1;\n');
  const server = await startMcpServer({ port: 0, token, sessionIdleMs: 100, sessionSweepMs: 20 });
  const a = await connect(server.url), b = await connect(server.url);
  t.after(async () => { await Promise.all([a, b].map(async x => { await x.client.close(); })); await server.close(); rmSync(root, { recursive: true, force: true }); });
  await a.client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } });
  await delay(300);
  await a.client.ping();
  assert.equal((await b.client.callTool({ name: 'graft_build', arguments: { project_root: root } })).isError, false);
  await delay(50);
  assert.equal(a.events.filter(e => e.status === 'completed').length, 1);
});

test('concurrent initialization respects the session admission limit', async t => {
  const server = await startMcpServer({ port: 0, token, maxSessions: 2 });
  t.after(() => server.close());
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => connect(server.url)));
  const connected = attempts.filter(x => x.status === 'fulfilled');
  assert.equal(connected.length, 2);
  for (const result of connected) if (result.status === 'fulfilled') await result.value.client.close();
});


test('hookless clients get upkeep through the worker and builds are tracked', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-upkeep-'));
  writeStamp(root, '0.0.1', ['gemini'], { global: false });
  const server = await startMcpServer({ port: 0, token });
  const { client } = await connect(server.url);
  t.after(async () => { await client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const answer: any = await client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } });
  assert.match(answer.content.map((item: any) => item.text).join('\n'), /refreshed this repo/);
  const second = await client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } });
  assert.doesNotMatch(JSON.stringify(second), /refreshed this repo/);
  assert.equal(readStamp(root)?.version, runningVersion());
  assert.ok(existsSync(join(root, 'GEMINI.md')));
  assert.equal(existsSync(join(root, '.gemini', 'settings.json')), false, 'upkeep must not register HTTP');
  assert.ok(isTrackedCommand('build'));
});

test('shutdown tolerates concurrent keep-alive requests', { timeout: 5000 }, async () => {
  const server = await startMcpServer({ port: 0, token });
  await fetch(server.url, { headers });
  const requests = Array.from({ length: 20 }, () => fetch(server.url, { headers }));
  await Promise.allSettled([...requests, server.close()]);
  await server.close();
});


test('progress keeps a build alive beyond the inactivity deadline; log levels filter completion', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-progress-'));
  writeFileSync(join(root, 'index.ts'), 'export const ready = 1;\n');
  const pool = new ToolPool(1, 5000, 5000);
  const server = await startMcpServer({ port: 0, token });
  const a = await connect(server.url), b = await connect(server.url);
  t.after(async () => { await pool.close(); await a.client.close(); await b.client.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  await pool.run(root, 'graft_repo_map', {}, undefined, () => {});
  (pool as any).jobTimeoutMs = 600;
  const cache = join(root, 'graft', '.cache');
  assert.ok(acquireLockIn(cache));
  const build = pool.run(root, 'graft_build', {}, undefined, () => {});
  await delay(1500); // Longer than the deadline, but the lock wait reports progress.
  releaseLockIn(cache);
  assert.equal((await build).isError, false);
  await a.client.callTool({ name: 'graft_repo_map', arguments: { project_root: root } });
  await a.client.setLoggingLevel('error');
  await b.client.callTool({ name: 'graft_build', arguments: { project_root: root } });
  await delay(100);
  assert.equal(a.events.length, 0);
  assert.equal(b.events.filter(e => e.status === 'completed').length, 1);
});

test('query timeout serves the last saved graph; a non-building query crash emits no build failure', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-fallback-'));
  writeFileSync(join(root, 'index.ts'), 'export const previous = 1;\n');
  await buildGraph(root);
  const pool = new ToolPool(1, 5000, 2000);
  const events: any[] = [];
  t.after(async () => { await pool.close(); rmSync(root, { recursive: true, force: true }); });
  await pool.run(root, 'graft_repo_map', {}, undefined, () => {});
  // Pause a query before it starts. There was no build, so no build-failed notification is valid.
  (pool as any).slots[0].child.kill('SIGSTOP');
  const answer = await pool.run(root, 'graft_find_all', { pattern: 'previous' }, undefined, e => events.push(e));
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /may be stale/);
  assert.match(answer.text, /previous/);
  assert.equal(events.length, 0);
});

test('explicit MCP build widens a previous --only-dir build', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-wide-'));
  for (const dir of ['src', 'lib']) { mkdirSync(join(root, dir)); writeFileSync(join(root, dir, 'index.ts'), `export const ${dir} = 1;\n`); }
  await buildGraph(root, { onlyDirs: ['src'] });
  const pool = new ToolPool(1);
  t.after(async () => { await pool.close(); rmSync(root, { recursive: true, force: true }); });
  const built = await pool.run(root, 'graft_build', {}, undefined, () => {});
  assert.equal(built.isError, false, built.text);
  const found = await pool.run(root, 'graft_find_all', { pattern: 'lib' }, undefined, () => {});
  assert.match(found.text, /lib/);
});

test('a busy workspace child can take longer than the former 30-second lock limit', { timeout: 45_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-busy-child-'));
  for (const name of ['one', 'two']) {
    mkdirSync(join(root, name));
    execFileSync('git', ['init', '-q', join(root, name)]);
    writeFileSync(join(root, name, 'index.ts'), `export const ${name} = 1;\n`);
  }
  const cache = join(root, 'two', 'graft', '.cache');
  assert.ok(acquireLockIn(cache));
  const pool = new ToolPool(1);
  t.after(async () => { releaseLockIn(cache); await pool.close(); rmSync(root, { recursive: true, force: true }); });
  const pending = pool.run(root, 'graft_build', {}, undefined, () => {});
  await delay(32_000);
  releaseLockIn(cache);
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.ok(existsSync(JSON.parse(result.text).graph_path));
});


test('failed session close logs the error and releases admission capacity', { timeout: 5000 }, async t => {
  const server = await startMcpServer({ port: 0, token, maxSessions: 1, sessionIdleMs: 20, sessionSweepMs: 10 });
  t.after(() => server.close());
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const original = SdkServer.prototype.close;
  let injected = false;
  t.mock.method(SdkServer.prototype, 'close', async function(this: SdkServer) {
    if (!injected) { injected = true; throw new Error('injected close failure'); }
    return original.call(this);
  });
  const response = await fetch(server.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'idle', version: '1' } } }) });
  assert.equal(response.status, 200);
  await response.text();
  await delay(100);
  const next = await connect(server.url);
  assert.ok(logs.some(args => args.some(arg => String(arg).includes('injected close failure'))));
  await next.client.close();
});

test('chunked oversized JSON receives 413', async t => {
  const server = await startMcpServer({ port: 0, token });
  t.after(() => server.close());
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(' '.repeat(1_048_576));
    req.end(' ');
  });
  assert.equal(status, 413);
});


test('HTTP rejects outside output paths and output symlinks without deleting user files', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-http-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'graft-http-home-'));
  for (const child of ['one', 'two']) { mkdirSync(join(root, child)); execFileSync('git', ['init', '-q', join(root, child)]); }
  const files = ['.cache/mozilla/profile.db', '.cache/paru-pkg.tar', '.graph/foreign.json', 'INDEX.md', 'unrelated.txt'];
  for (const file of files) { mkdirSync(join(outside, file, '..'), { recursive: true }); writeFileSync(join(outside, file), file); }
  const server = await startMcpServer({ port: 0, token });
  const { client } = await connect(server.url);
  t.after(async () => { await client.close(); await server.close(); for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true }); });
  for (const output of [outside, root]) {
    const result = await client.callTool({ name: 'graft_build', arguments: { project_root: root, context_dir: output } });
    assert.equal(result.isError, true);
    assert.match(text(result), /strictly inside/);
  }
  symlinkSync(outside, join(root, 'graft'), 'dir');
  assert.equal((await client.callTool({ name: 'graft_build', arguments: { project_root: root } })).isError, true);
  unlinkSync(join(root, 'graft'));
  mkdirSync(join(root, 'graft'));
  symlinkSync(join(outside, '.cache'), join(root, 'graft', '.cache'), 'dir');
  assert.equal((await client.callTool({ name: 'graft_build', arguments: { project_root: root } })).isError, true);
  unlinkSync(join(root, 'graft', '.cache'));
  writeFileSync(join(root, 'graft', 'workspace.json'), JSON.stringify({ version: 1, children: ['one', 'two'] }));
  symlinkSync(outside, join(root, 'one', 'graft'), 'dir');
  assert.equal((await client.callTool({ name: 'graft_find_all', arguments: { project_root: root, pattern: 'anything' } })).isError, true);
  for (const file of files) assert.equal(readFileSync(join(outside, file), 'utf8'), file);
});

test('authentication diagnostics classify failures without exposing token values', async t => {
  const server = await startMcpServer({ port: 0, token });
  t.after(() => server.close());
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.join(' ')));
  for (const header of [undefined, 'Bearer ', 'Bearer ${GRAFT_MCP_TOKEN}', 'Bearer wrong-secret', 'Basic forbidden-secret']) {
    assert.equal((await fetch(server.url, { headers: header ? { Authorization: header } : {} })).status, 401);
  }
  for (const reason of ['missing-header', 'empty-token', 'unexpanded-variable', 'token-mismatch', 'invalid-scheme']) assert.ok(logs.some(log => log.includes(reason)));
  assert.doesNotMatch(logs.join('\n'), /wrong-secret|forbidden-secret|test-token-only/);
});

test('queued warm-repo work runs before replacing its worker for a cold repo', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-pool-order-'));
  const cold = mkdtempSync(join(tmpdir(), 'graft-pool-cold-'));
  const pool = new ToolPool(1, 5000);
  t.after(async () => { await pool.close(); for (const dir of [root, cold]) rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(root, 'index.ts'), 'export const value = 1;');
  const cache = join(root, 'graft', '.cache');
  assert.ok(acquireLockIn(cache));
  const build = pool.run(root, 'graft_build', {}, undefined, () => {});
  const order: string[] = [];
  const coldJob = pool.run(cold, 'graft_repo_map', {}, undefined, () => {}).then(() => order.push('cold'));
  const warmJob = pool.run(root, 'graft_repo_map', {}, undefined, () => {}).then(() => order.push('warm'));
  releaseLockIn(cache);
  await Promise.all([build, coldJob, warmJob]);
  assert.deepEqual(order, ['warm', 'cold']);
});
