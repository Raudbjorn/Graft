import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMcpServer } from '../src/mcp/server.js';
import { buildForMcp } from '../src/mcp/build.js';

function child(script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, GRAFT_TELEMETRY: '0' },
  });
}

test('post-startup listener errors are logged and exit with failure', () => {
  const result = child(`
    import { Server } from 'node:http';
    import { startMcpServer } from './src/mcp/server.ts';
    const original = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      this.once('listening', () => setTimeout(() => this.emit('error', new Error('injected runtime failure')), 20));
      return original.apply(this, args);
    };
    await startMcpServer({ port: 0, token: 'test-runtime-token' });
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /MCP listener failed:.*injected runtime failure/);
});

test('CLI exits with failure when shutdown rejects', () => {
  const result = child(`
    import { Server } from 'node:http';
    import { ToolPool } from './src/mcp/pool.ts';
    ToolPool.prototype.close = async () => { throw new Error('injected shutdown failure'); };
    const original = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      args[0] = 0;
      this.once('listening', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50));
      return original.apply(this, args);
    };
    process.env.GRAFT_MCP_TOKEN = 'test-shutdown-token';
    delete process.env.GRAFT_MCP_URL;
    process.execArgv = [];
    process.argv = [process.execPath, 'src/cli.ts', 'mcp'];
    await import('./src/cli.ts');
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /MCP shutdown failed:.*injected shutdown failure/);
});

test('default-port loopback Host and Origin are accepted', async t => {
  let server: Awaited<ReturnType<typeof startMcpServer>>;
  try { server = await startMcpServer({ port: 80, token: 'test-port-token' }); }
  catch (error: any) {
    if (error.code === 'EACCES' || error.code === 'EADDRINUSE') { t.skip(`port 80 unavailable: ${error.code}`); return; }
    throw error;
  }
  t.after(() => server.close());
  const result = await fetch('http://127.0.0.1/mcp', { headers: { Authorization: 'Bearer test-port-token', Origin: 'http://127.0.0.1' } });
  assert.equal(result.status, 400, 'request passes Host, Origin and auth and reaches the session guard');
  const foreign = await fetch(server.url, { headers: { Authorization: 'Bearer test-port-token', Host: 'evil.example' } });
  assert.equal(foreign.status, 403);
});

test('lock acquisition errors emit failure without deleting unrelated data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-lock-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'graft'));
  writeFileSync(join(root, 'graft', '.cache'), 'user file blocks lock directory');
  const events: any[] = [];
  await assert.rejects(buildForMcp(root, undefined, event => events.push(event)));
  assert.equal(events.filter(event => event.status === 'failed').length, 1);
  assert.equal(readFileSync(join(root, 'graft', '.cache'), 'utf8'), 'user file blocks lock directory');
});

test('setup and unit agree on token path despite differing XDG_CONFIG_HOME', { skip: process.platform !== 'linux' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'graft-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'user');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'node'), `#!/bin/sh
if [ "$1" = "-p" ]; then
  printf '%s\\n' "$GRAFT_TEST_HOME/.config/graft"
else
  exec "$GRAFT_REAL_NODE" "$@"
fi
`);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  for (const file of ['node', 'systemctl']) chmodSync(join(bin, file), 0o755);
  const result = spawnSync('bash', [resolve('packaging/arch/graft-mcp-setup')], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAFT_TEST_HOME: home,
      GRAFT_REAL_NODE: process.execPath, XDG_CONFIG_HOME: join(root, 'different-manager-config') },
  });
  assert.equal(result.status, 0, result.stderr);
  const unit = readFileSync('packaging/arch/graft-mcp.service', 'utf8');
  const tokenFile = unit.match(/^EnvironmentFile=(.+)$/m)![1].replace('%h', home);
  assert.ok(existsSync(tokenFile));
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, 'different-manager-config', 'graft', 'mcp.env')), false);
});
