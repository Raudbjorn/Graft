import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGraph } from '../graph/build.js';
import { discoverWorkspaceChildren } from '../graph/scopes.js';
import { readFingerprint } from '../graph/fingerprint.js';
import { invalidateGraphCaches } from '../graph/load.js';
import { releaseOnSignal } from '../graph/refresh.js';
import { isWorkspaceBuildRoot, writeWorkspace } from '../graph/workspace.js';
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
  const deadline = Date.now() + 300_000;
  while (!acquireLockIn(cache)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the graph build lock');
    await delay(50);
  }
  const unhook = releaseOnSignal(cache);
  event('started');
  try {
    if (isWorkspaceBuildRoot(root, contextDir)) {
      const children = discoverWorkspaceChildren(root).sort();
      const results: Record<string, unknown>[] = [];
      for (const child of children) results.push(await buildForMcp(join(root, child), undefined, onBuild));
      // Keep existing files: a custom output directory may contain user data.
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
