import { lstatSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { isStrictlyInside } from '../util/paths.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Resolve the output path and enforce containment without walking its contents. */
export function validateOutputDirectory(root: string, value?: unknown): string {
  if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value)))
    throw new Error('context_dir must be an absolute directory path');
  const requested = resolve(typeof value === 'string' ? value : join(root, 'graft'));
  let ancestor = requested;
  const missing: string[] = [];
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('context_dir has no existing ancestor');
    ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory()) throw new Error('context_dir must be a directory');
  const output = join(realpathSync(ancestor), ...missing);
  if (!isStrictlyInside(realpathSync(root), output))
    throw new Error('context_dir must be strictly inside project_root');
  return output;
}

/** Run immediately before a write, in the worker; read-only calls do not scan cards. */
export function validateOutputForWrite(root: string, value?: unknown): string {
  const output = validateOutputDirectory(root, value);
  const inspect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Graph output must not contain symlinks');
      if (entry.isDirectory()) inspect(join(dir, entry.name));
    }
  };
  if (lstatSync(output, { throwIfNoEntry: false })) inspect(output);
  return output;
}
