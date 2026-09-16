import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CACHE_DIR, contextDirFor } from '../context/node-file.js';
import { processIdentity, releaseOwnedLock } from '../util/state.js';
import { MCP_WORKERS, MCP_WORKER_IDLE_MS, jobTimeoutMs as configuredJobTimeoutMs, MCP_MAX_QUEUED_JOBS, MCP_MAX_BUILD_WAITERS, MCP_SHUTDOWN_GRACE_MS } from './config.js';
import { fileURLToPath } from 'node:url';
import type { BuildEvent, BuildListener } from './build.js';

type Result = { text: string; isError: boolean; notices?: string[] };
interface Job {
  root: string; name: string; args: Record<string, unknown>; contextDir?: string;
  skipRefresh: boolean; rearm?: () => void; timer?: NodeJS.Timeout; key: string; resolve: (result: Result) => void; reject: (error: Error) => void; onBuild: BuildListener;
}
interface Slot { child: ChildProcess; key?: string; job?: Job; timer?: NodeJS.Timeout; outputs: Set<string>; builds: Map<string, BuildEvent>; root?: string; retiring?: boolean; failure?: Error; settled?: boolean; identity?: string }

/** Bounded reusable processes: tree-sitter and per-query globals stay off the HTTP loop. */
export class ToolPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private closed = false;
  private builds = new Map<string, { promise: Promise<Result>; listeners: Set<BuildListener> }>();
  constructor(private max = MCP_WORKERS, private idleMs = MCP_WORKER_IDLE_MS, private jobTimeoutMs = configuredJobTimeoutMs()) {}

  run(root: string, name: string, args: Record<string, unknown>, contextDir: string | undefined, onBuild: BuildListener, skipRefresh = false): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('MCP server is shutting down'));
    const key = JSON.stringify([root, resolve(contextDirFor(root, contextDir))]);
    const build = name === 'graft_build' ? this.builds.get(key) : undefined;
    if (build) {
      if (build.listeners.size >= MCP_MAX_BUILD_WAITERS) return Promise.reject(new Error('Too many callers waiting for this build'));
      build.listeners.add(onBuild); return build.promise;
    }
    if (this.queue.length >= MCP_MAX_QUEUED_JOBS) return Promise.reject(new Error('MCP work queue is full; retry later'));
    const listeners = new Set([onBuild]);
    const promise = new Promise<Result>((resolve, reject) => {
      const job: Job = { root, name, args, contextDir, skipRefresh, key, resolve, reject,
        // A terminal callback broadcasts to ALL subscribed sessions; doing it once avoids duplicate notifications.
        onBuild: event => { for (const listener of listeners) { listener(event); if (event.status !== 'progress') break; } } };
      const expire = () => {
        const slot = this.slots.find(s => s.job === job);
        const error = new Error(`MCP job exceeded ${this.jobTimeoutMs}ms without progress (or waiting in queue)`);
        if (slot) {
          slot.retiring = true;
          slot.failure = error;
          slot.child.kill('SIGKILL'); // A CPU-bound parser cannot service a graceful signal.
        } else {
          this.queue = this.queue.filter(j => j !== job);
          job.reject(error);
        }
      };
      job.rearm = () => { clearTimeout(job.timer); job.timer = setTimeout(expire, this.jobTimeoutMs); };
      job.rearm();
      this.queue.push(job);
      this.drain();
    });
    if (name === 'graft_build') {
      this.builds.set(key, { promise, listeners });
      void promise.then(() => this.builds.delete(key), () => this.builds.delete(key));
    }
    return promise.catch(async error => {
      if (name === 'graft_build' || skipRefresh || this.closed) throw error;
      const result = await this.run(root, name, args, contextDir, onBuild, true);
      return { ...result, text: `Graph refresh failed (${error.message}); answering from the last saved graph, which may be stale.\n${result.text}` };
    });
  }

  private drain(): void {
    if (this.closed) return;
    for (;;) {
      const available = (job: Job) => !this.slots.some(slot => slot.job?.key === job.key);
      const placeable = this.queue.findIndex(job => available(job) && (this.slots.length < this.max
        || this.slots.some(slot => !slot.retiring && !slot.job && slot.root === job.root)));
      const next = placeable >= 0 ? placeable : this.queue.findIndex(available);
      if (next < 0) return;
      const job = this.queue[next];
      let slot = this.slots.find(s => !s.retiring && !s.job && s.key === job.key)
        ?? this.slots.find(s => !s.retiring && !s.job && s.root === job.root);
      if (!slot && this.slots.length < this.max) slot = this.spawn();
      if (!slot) {
        const idle = this.slots.find(s => !s.retiring && !s.job && !this.queue.some(job => job.root === s.root))
          ?? this.slots.find(s => !s.retiring && !s.job);
        if (idle) {
          idle.retiring = true;
          clearTimeout(idle.timer);
          idle.child.kill('SIGTERM');
          idle.timer = setTimeout(() => idle.child.kill('SIGKILL'), MCP_SHUTDOWN_GRACE_MS);
        }
        return; // Exit cleanup will allocate a fresh process for the new root.
      }
      this.queue.splice(next, 1);
      clearTimeout(slot.timer);
      slot.outputs.clear();
      slot.builds.clear();
      slot.root = job.root;
      job.rearm?.();
      const output = contextDirFor(job.root, job.contextDir);
      slot.outputs.add(output);
      if (job.name === 'graft_build') slot.builds.set(output, { project_root: job.root, context_dir: output, status: 'started' });
      slot.job = job;
      slot.key = job.key;
      slot.child.send({ root: job.root, name: job.name, args: job.args, contextDir: job.contextDir, skipRefresh: job.skipRefresh }, error => {
        if (error) slot!.child.kill();
      });
    }
  }

  private spawn(): Slot {
    let entry = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (!existsSync(entry)) entry = entry.replace(/\.js$/, '.ts');
    const slot: Slot = { child: fork(entry, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }), outputs: new Set(), builds: new Map() };
    slot.identity = slot.child.pid === undefined ? undefined : processIdentity(slot.child.pid);
    this.slots.push(slot);
    slot.child.on('message', (message: { event?: BuildEvent; result?: Result }) => {
      if (slot.retiring) return;
      if (message.event) {
        slot.job?.rearm?.();
        if (message.event.status === 'started') { slot.outputs.add(message.event.context_dir); slot.builds.set(message.event.context_dir, message.event); }
        if (message.event.status === 'completed' || message.event.status === 'failed') slot.builds.delete(message.event.context_dir);
        slot.job?.onBuild(message.event);
        return;
      }
      if (!message.result || !slot.job) return;
      clearTimeout(slot.job.timer);
      slot.job.resolve(message.result);
      slot.job = undefined;
      slot.timer = setTimeout(() => {
        this.slots = this.slots.filter(s => s !== slot);
        slot.child.kill();
      }, this.idleMs);
      slot.timer.unref();
      this.drain();
    });
    const failed = (error: Error) => {
      if (slot.settled) return;
      slot.settled = true;
      error = slot.failure ?? error;
      clearTimeout(slot.timer);
      // SIGKILL/native crashes cannot run the worker's finally or signal handler.
      if (slot.child.pid !== undefined) for (const out of slot.outputs)
        releaseOwnedLock(join(out, CACHE_DIR), slot.child.pid, slot.identity);
      if (slot.job) {
        clearTimeout(slot.job.timer);
        for (const event of slot.builds.values()) slot.job.onBuild({ ...event, status: 'failed', message: error.message });
        slot.job.reject(error);
      }
      slot.job = undefined;
      this.slots = this.slots.filter(s => s !== slot);
      this.drain();
    };
    slot.child.on('error', failed);
    slot.child.on('exit', (code, signal) => failed(new Error(`MCP worker exited (${signal ?? code})`)));
    return slot;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) { clearTimeout(job.timer); job.reject(new Error('MCP server is shutting down')); }
    await Promise.all(this.slots.map(slot => new Promise<void>(resolve => {
      clearTimeout(slot.timer);
      clearTimeout(slot.job?.timer);
      slot.retiring = true;
      slot.job?.reject(new Error('MCP server is shutting down'));
      slot.child.once('exit', () => { clearTimeout(kill); resolve(); });
      const kill = setTimeout(() => slot.child.kill('SIGKILL'), MCP_SHUTDOWN_GRACE_MS);
      slot.child.kill('SIGTERM');
    })));
  }
}
