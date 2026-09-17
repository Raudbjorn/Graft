import { join } from 'node:path';
import { readWorkspace } from '../graph/workspace.js';
import { validateOutputDirectory, validateOutputForWrite } from './paths.js';
import { callTool } from './tools.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { MCP_PROGRESS_INTERVAL_MS } from './config.js';
import { track } from '../telemetry/index.js';

function send(message: object): void {
  if (!process.connected) { process.kill(process.pid, 'SIGTERM'); return; }
  try {
    process.send?.(message, error => {
      if (error) { console.error('MCP worker IPC failed:', error.message); process.kill(process.pid, 'SIGTERM'); }
    });
  } catch (error) {
    console.error('MCP worker IPC failed:', error);
    process.kill(process.pid, 'SIGTERM');
  }
}

let upkeep: string[] | undefined;
process.on('message', async (job: { root: string; name: string; args: Record<string, unknown>; contextDir?: string; skipRefresh?: boolean }) => {
  try {
    validateOutputDirectory(job.root, job.contextDir);
    for (const child of readWorkspace(job.root, job.contextDir)?.children ?? [])
      validateOutputDirectory(job.root, join(job.root, child, 'graft'));
    upkeep ??= runUpkeep(job.root, runningVersion()).lines;
    let lastProgress = 0;
    const result = await callTool(job.root, job.name, job.args, job.contextDir,
      (event) => {
        if (event.status === 'progress') {
          if (Date.now() - lastProgress < MCP_PROGRESS_INTERVAL_MS) return;
          lastProgress = Date.now();
        }
        send({ event });
      }, job.skipRefresh, (_root, output) => { validateOutputForWrite(job.root, output); });
    const commands: Record<string, string> = { graft_build: 'build', graft_find_code: 'ask', graft_find_all: 'grep',
      graft_trace_calls: 'callers', graft_file_api: 'skeleton', graft_repo_map: 'map', graft_check_freshness: 'check' };
    if (Object.hasOwn(commands, job.name)) track('query', { command: commands[job.name], surface: 'mcp' }, { repo: job.root, host: 'mcp' });
    send({ result: { ...result, notices: upkeep } });
    upkeep = [];
  } catch (error) {
    send({ result: { text: String(error), isError: true } });
  }
});
// The daemon owns this process; never survive a lost IPC connection.
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
