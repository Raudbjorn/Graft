import { join } from 'node:path';
import { readWorkspace } from '../graph/workspace.js';
import { validateOutputDirectory } from './paths.js';
import { callTool } from './tools.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { MCP_PROGRESS_INTERVAL_MS } from './config.js';
import { track } from '../telemetry/index.js';

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
        process.send?.({ event });
      }, job.skipRefresh);
    const commands: Record<string, string> = { graft_build: 'build', graft_find_code: 'ask', graft_find_all: 'grep',
      graft_trace_calls: 'callers', graft_file_api: 'skeleton', graft_repo_map: 'map', graft_check_freshness: 'check' };
    if (Object.hasOwn(commands, job.name)) track('query', { command: commands[job.name], surface: 'mcp' }, { repo: job.root, host: 'mcp' });
    process.send?.({ result: { ...result, notices: upkeep } });
    upkeep = [];
  } catch (error) {
    process.send?.({ result: { text: String(error), isError: true } });
  }
});
// The daemon owns this process; never survive a lost IPC connection.
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
