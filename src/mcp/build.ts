import { MCP_BUILD_LOCK_WAIT_MS, MCP_BUILD_LOCK_POLL_MS } from './config.js';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGraph } from '../graph/build.js';
import { discoverWorkspaceChildren } from '../graph/scopes.js';
import { readFingerprint } from '../graph/fingerprint.js';
import { invalidateGraphCaches } from '../graph/load.js';
import { releaseOnSignal } from '../graph/refresh.js';
import { clearParentGraft, isWorkspaceBuildRoot, writeWorkspace } from '../graph/workspace.js';
import { CACHE_DIR, contextDirFor, ensureGitignored } from '../context/node-file.js';
import { acquireLockIn, releaseLockIn } from '../util/state.js';

export interface BuildEvent {
  project_root: string;
  context_dir: string;
  status: 'started' | 'progress' | 'completed' | 'failed';
  progress?: number;
  total?: number;
  message?: string;
  graph_path?: string;
}
export type BuildListener = (event: BuildEvent) => void;

export async function buildForMcp(root: string, contextDir?: string, onBuild?: BuildListener): Promise<Record<string, unknown>> {
  const out = contextDirFor(root, contextDir);
  const event = (status: BuildEvent['status'], extra: Partial<BuildEvent> = {}) =>
    onBuild?.({ project_root: root, context_dir: out, status, ...extra });
  const cache = join(out, CACHE_DIR);
  const deadline = Date.now() + MCP_BUILD_LOCK_WAIT_MS;
  while (!acquireLockIn(cache)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the graph build lock');
    await delay(MCP_BUILD_LOCK_POLL_MS);
  }
  const unhook = releaseOnSignal(cache);
  event('started');
  try {
    if (isWorkspaceBuildRoot(root, contextDir)) {
      const children = discoverWorkspaceChildren(root).sort();
      const results: Record<string, unknown>[] = [];
      for (const child of children) results.push(await buildForMcp(join(root, child), undefined, onBuild));
      clearParentGraft(root, contextDir, true);
      invalidateGraphCaches(out);
      const graph_path = writeWorkspace(root, { version: 1, children }, contextDir);
      ensureGitignored(root, out);
      event('completed', { graph_path });
      return { project_root: root, context_dir: out, graph_path, children: results };
    }
    const result = await buildGraph(root, {
      contextDir,
      onlyDirs: readFingerprint(out)?.onlyDirs,
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
    unhook();
    releaseLockIn(cache);
  }
}
