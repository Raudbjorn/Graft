/**
 * Muse project hooks — the adapter that keeps graft's graph fresh inside
 * Muse Code sessions (Meta's `muse` CLI).
 *
 * Like the Cursor project hooks (see ./cursor-hooks.ts) these are **repo-local**:
 * `.muse/hooks.json` + a shim under `.muse/hooks/`. That matches graft's
 * repo-local posture for non-Codex hosts — a `--no-global` init that never
 * writes outside the repo — so these are scoped 'repo' and are NOT suppressed
 * by `--global false`; only `--no-hooks` skips them. (Muse's MCP registration
 * is the exception: it lives in the user-level `~/.config/muse/settings.json`,
 * so it IS global-scoped — see the `muse` case in ./mcp-config.ts.)
 *
 * The shim is the same one Claude Code and Codex use (`hooksShim`): it locates
 * the installed `@nanonets/graft` package and calls `hooks.js`' `main(argv[2])`,
 * so the sub-command in each entry (`post-edit`, `session-start`) routes to the
 * matching handler in `../claude/hooks.ts`. No Muse-specific runtime code —
 * the shared hook script stays the single source of truth.
 *
 * Events and file shape, confirmed against the live binary (muse-bin-1.0.3,
 * probed with marker hooks rather than guessed from the research report):
 *   - the file nests events under a top-level `hooks` key, Claude-settings
 *     style: `{"hooks": {"PostToolUse": [...]}}`. Top-level event keys do NOT
 *     fire — the report's flat shape was verified dead.
 *   - `PostToolUse` (matcher `Write|Edit`, which also matches Muse's native
 *     `edit_file` tool) → `post-edit`: marks the graph dirty and emits a blast
 *     radius. Fail-open by construction: the handler never throws and the shim
 *     no-ops when graft is unavailable, so a stale graph can't break the loop.
 *     (Hook commands run through a shell here, but no `|| true` is appended:
 *     the command itself always exits 0.)
 *   - `SessionStart` → `session-start`: upkeep plus orientation from
 *     `graft/INDEX.md` — the budget-capped equivalent of `graft map`
 *     (which carries no `--budget` flag; it is token-budgeted by design).
 *
 * Project hooks load only once the workspace is trusted; until then Muse skips
 * the file silently, which is also why a `graft init` that writes it needs no
 * session restart to be *correct* — the next trusted session picks it up.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

function shimPathFor(repo: string): string {
  return join(repo, '.muse', 'hooks', 'graft-hooks.cjs');
}
function configPathFor(repo: string): string {
  return join(repo, '.muse', 'hooks.json');
}

/**
 * The files a Muse-hooks install would touch — pure, no writes. Both are
 * repo-local, so both are scoped 'repo' (they fire only in this repo). Always
 * returns the pair: like Cursor there is no "is the CLI installed" gate — the
 * repo's own `.muse/` is what we write.
 */
export function museHookTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'muse', id: 'muse-hook-shim',
      path: shimPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'session hook shim',
    },
    {
      hostId: 'muse', id: 'muse-hooks',
      path: configPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'PostToolUse / SessionStart',
    },
  ];
}

/**
 * The graft hook entries Muse should carry. `matcher` is set only where Muse
 * filters by tool (PostToolUse); `SessionStart` fires for none, so it carries
 * no matcher. Timeouts mirror the Claude Code entries for the same handlers.
 */
interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'PostToolUse', matcher: 'Write|Edit', sub: 'post-edit', timeout: 10000 },
    { event: 'SessionStart', sub: 'session-start', timeout: 8000 },
  ];
}

/**
 * Install (or refresh) graft's Muse project hooks in `repo`. Idempotent, and
 * conservative with a hand-edited config: an unparseable or wrong-shaped
 * `hooks.json` is left exactly as-is (reported `skipped-unparseable`) rather than
 * clobbered. Foreign hook entries are preserved; a stale graft entry is replaced
 * so an upgrade re-points to the current shim/sub-command instead of stacking.
 */
export function installMuseHooks(repo: string): ConfigWrite[] {
  const shimPath = shimPathFor(repo);
  const shimWrite = writeOwned('muse-hook-shim', shimPath, hooksShim(), 0o755);
  const cfgPath = configPathFor(repo);
  const skipped: ConfigWrite = { id: 'muse-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  for (const d of desiredEntries()) {
    if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event])) return [shimWrite, skipped];
    const prior: unknown[] = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
    const command = `node "${shimPath}" ${d.sub}`;
    const handler = { type: 'command', command, timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    hooks[d.event] = [...prior.filter((e) => !isGraftEntry(e)), entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'muse-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'muse-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
