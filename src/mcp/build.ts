import { MCP_BUILD_LOCK_WAIT_MS, MCP_BUILD_LOCK_POLL_MS } from './config.js';
import { validateOutputForWrite } from './paths.js';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGraph } from '../graph/build.js';
import { invalidateGraphCaches } from '../graph/load.js';
import { releaseOnSignal } from '../graph/refresh.js';
import { splitWorkspace, migrationNote, workspacePath, isWorkspaceBuildRoot } from '../graph/workspace.js';
import { CACHE_DIR, contextDirFor, ensureGitignored } from '../context/node-file.js';
import { acquireLockIn, releaseLockIn } from '../util/state.js';

import type { BuildEvent, BuildListener } from '../graph/types.js';

export async function buildForMcp(root: string, contextDir?: string, onBuild?: BuildListener, workspaceRoot = root): Promise<Record<string, unknown>> {
  const out = validateOutputForWrite(workspaceRoot, contextDirFor(root, contextDir));
  const event = (status: BuildEvent['status'], extra: Partial<BuildEvent> = {}) =>
    onBuild?.({ project_root: root, context_dir: out, status, ...extra });
  const cache = join(out, CACHE_DIR);
  let locked = false;
  let unhook: (() => void) | undefined;
  try {
    const deadline = Date.now() + MCP_BUILD_LOCK_WAIT_MS;
    while (!(locked = acquireLockIn(cache))) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the graph build lock');
      event('progress', { message: 'Waiting for another graph builder' });
      await delay(MCP_BUILD_LOCK_POLL_MS);
    }
    unhook = releaseOnSignal(cache);
    event('started');
    if (isWorkspaceBuildRoot(root, contextDir)) {
      const results: Record<string, unknown>[] = [];
      const { children, migrated } = await splitWorkspace(root, contextDir,
        async child => { results.push(await buildForMcp(child, undefined, onBuild, workspaceRoot)); },
        ({ children, migrated }) => { if (migrated) event('progress', { message: migrationNote(children) }); }, true);
      invalidateGraphCaches(out);
      const graph_path = workspacePath(root, contextDir);
      ensureGitignored(root, out);
      event('completed', { graph_path });
      return { project_root: root, context_dir: out, graph_path, children: results, ...(migrated ? { message: migrationNote(children) } : {}) };
    }
    const result = await buildGraph(root, {
      contextDir,
      onProgress: ({ index, total }) => event('progress', { progress: index, total }),
    });
    invalidateGraphCaches(out);
    event('completed', { graph_path: result.graphPath });
    return { project_root: root, context_dir: out, graph_path: result.graphPath,
      files: result.files, nodes: result.nodes, edges: result.edges, cards: result.cards,
      parsed: result.parsed, reused: result.reused, errors: result.errors };
  } catch (error) {
    event('failed', { message: String(error) });
    throw error;
  } finally {
    unhook?.();
    if (locked) releaseLockIn(cache);
  }
}
