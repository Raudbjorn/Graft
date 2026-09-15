import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildEvent, BuildListener } from './build.js';

type Result = { text: string; isError: boolean };
interface Job {
  root: string; name: string; args: Record<string, unknown>; contextDir?: string;
  key: string; resolve: (result: Result) => void; reject: (error: Error) => void; onBuild: BuildListener;
}
interface Slot { child: ChildProcess; key?: string; job?: Job; timer?: NodeJS.Timeout; outputs: Set<string> }

/** Bounded reusable processes: tree-sitter and per-query globals stay off the HTTP loop. */
export class ToolPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private closed = false;
  private builds = new Map<string, { promise: Promise<Result>; listeners: Set<BuildListener> }>();
  constructor(private max = 4, private idleMs = 60_000) {}

  run(root: string, name: string, args: Record<string, unknown>, contextDir: string | undefined, onBuild: BuildListener): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('MCP server is shutting down'));
    const key = JSON.stringify([root, contextDir]);
    const build = name === 'graft_build' ? this.builds.get(key) : undefined;
    if (build) { build.listeners.add(onBuild); return build.promise; }
    if (this.queue.length >= 256) return Promise.reject(new Error('MCP work queue is full; retry later'));
    const listeners = new Set([onBuild]);
    const promise = new Promise<Result>((resolve, reject) => {
      this.queue.push({ root, name, args, contextDir, key, resolve, reject,
        onBuild: event => { for (const listener of listeners) { listener(event); if (event.status !== 'progress') break; } } });
      this.drain();
    });
    if (name === 'graft_build') {
      this.builds.set(key, { promise, listeners });
      void promise.finally(() => this.builds.delete(key)).catch(() => {});
    }
    return promise;
  }

  private drain(): void {
    if (this.closed) return;
    for (;;) {
      const next = this.queue.findIndex(job => !this.slots.some(slot => slot.job?.key === job.key));
      if (next < 0) return;
      const job = this.queue[next];
      let slot = this.slots.find(s => !s.job && s.key === job.key) ?? this.slots.find(s => !s.job);
      if (!slot && this.slots.length < this.max) slot = this.spawn();
      if (!slot) return;
      this.queue.splice(next, 1);
      clearTimeout(slot.timer);
      slot.outputs.clear();
      slot.job = job;
      slot.key = job.key;
      slot.child.send({ root: job.root, name: job.name, args: job.args, contextDir: job.contextDir }, error => {
        if (error) slot!.child.kill();
      });
    }
  }

  private spawn(): Slot {
    let entry = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (!existsSync(entry)) entry = entry.replace(/\.js$/, '.ts');
    const slot: Slot = { child: fork(entry, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }), outputs: new Set() };
    this.slots.push(slot);
    slot.child.on('message', (message: { event?: BuildEvent; result?: Result }) => {
      if (message.event) {
        if (message.event.status === 'started') slot.outputs.add(message.event.context_dir);
        slot.job?.onBuild(message.event);
        return;
      }
      if (!message.result || !slot.job) return;
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
      clearTimeout(slot.timer);
      // SIGKILL/native crashes cannot run the worker's finally or signal handler.
      for (const out of slot.outputs) {
        const lock = join(out, '.cache', '.sync.lock');
        try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === slot.child.pid) rmSync(lock); } catch { /* absent or owned by another builder */ }
      }
      if (slot.job) {
        slot.job.onBuild({ project_root: slot.job.root, context_dir: slot.job.contextDir ?? '', status: 'failed', message: error.message });
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
    for (const job of this.queue.splice(0)) job.reject(new Error('MCP server is shutting down'));
    await Promise.all(this.slots.map(slot => new Promise<void>(resolve => {
      clearTimeout(slot.timer);
      slot.job?.reject(new Error('MCP server is shutting down'));
      slot.child.once('exit', () => { clearTimeout(kill); resolve(); });
      const kill = setTimeout(() => slot.child.kill('SIGKILL'), 5000);
      slot.child.kill('SIGTERM');
    })));
  }
}
