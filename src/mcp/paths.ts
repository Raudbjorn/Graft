import { lstatSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve absent directories without exceptions; do not follow output-tree symlinks. */
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
  const inside = relative(realpathSync(root), output);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error('context_dir must be strictly inside project_root');
  const inspect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Graph output must not contain symlinks');
      if (entry.isDirectory()) inspect(join(dir, entry.name));
    }
  };
  if (lstatSync(output, { throwIfNoEntry: false })) inspect(output);
  return output;
}
