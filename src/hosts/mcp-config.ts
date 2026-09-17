/**
 * Register the graft MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `graft
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mcpUrl, DEFAULT_MCP_URL } from '../mcp/config.js';
import type { PlannedWrite } from './plan.js';
import { readJsonObject, type ConfigWrite } from './config-write.js';

/** MCP registration reports the same write-result record every installer does,
 *  plus `skipped` with the setup requirement or flag that prevented registration. */
export type McpWrite = ConfigWrite | { id: string; path: string; action: 'skipped'; reason?: string };

/** A planned MCP write, plus the detail needed to actually perform it. */
export interface McpTarget extends PlannedWrite {
  format: 'json' | 'toml';
  /** JSON only: the top-level key holding the server map. */
  topKey?: string;
  /** JSON only: the server entry to merge in under `graft`. */
  entry?: object;
  /** JSON only: top-level keys the host requires (applied as `??=` — a value
   *  the user already set is never overwritten). */
  defaults?: Record<string, unknown>;
  retired?: boolean;
}

/** Loopback endpoint shared by every client; secrets remain in the client's environment. */
export function serverEntry(url = mcpUrl()) {
  return { type: 'http', url,
    headers: { Authorization: 'Bearer ${GRAFT_MCP_TOKEN}' } };
}

function opencodeEntry(url: string): object {
  return { type: 'remote', url, enabled: true, oauth: false,
    headers: { Authorization: 'Bearer {env:GRAFT_MCP_TOKEN}' } };
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function mergeJsonKey(
  id: string,
  path: string,
  topKey: string,
  entry: object,
  opts: { defaults?: Record<string, unknown> } = {},
): ConfigWrite {
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const { root, existed } = loaded;
  // Host-mandated top-level keys (Muse's `schema_version: 1`) land before the
  // snapshot, so adding a missing one counts as a change and a present one —
  // even a differently-valued one, which is the user's to keep — stays put.
  for (const [k, v] of Object.entries(opts.defaults ?? {})) root[k] ??= v;
  const bucket = (root[topKey] ??= {});
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return { id, path, action: 'skipped-unparseable' };
  }
  const preferences = { ...(bucket.graft && typeof bucket.graft === 'object' ? bucket.graft : {}) };
  for (const key of ['command', 'args', 'env', 'transport', 'type', 'url', 'httpUrl', 'serverUrl', 'headers', 'oauth']) delete preferences[key];
  const next = { ...entry, ...preferences }; // Keep disabled/approval/timeout choices during transport migration.
  if (JSON.stringify(bucket.graft) === JSON.stringify(next)) return { id, path, action: 'unchanged' };
  const action = existed ? 'updated' : 'created';
  bucket.graft = next;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action };
}

/** The `[mcp_servers.graft]` table header, as written and as matched. */
const TOML_HEADER = '[mcp_servers.graft]';

/**
 * Remove the `[mcp_servers.graft]` table from a TOML config, returning the rest.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. The table runs from its header to the next `[`-header or EOF, which
 * is exactly the shape {@link upsertCodexToml} appends. Exported so the writer and
 * `retract.ts` can never disagree about what "graft's section" means.
 */
export function stripTomlSection(text: string): { rest: string; found: boolean } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === TOML_HEADER);
  if (start === -1) return { rest: text, found: false };
  let end = start + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith('[')) end++;
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
  return { rest, found: true };
}

/**
 * Register graft in a TOML config, replacing any section a previous version left.
 *
 * The old behaviour was to skip entirely once the header existed, which froze the
 * launch command at whatever the first init wrote: a repo wired when graft wasn't
 * on PATH kept the slow `npx` form forever, and no upgrade could correct it. Strip
 * and re-append instead, so this converges like every other writer — foreign
 * tables are untouched either way.
 */
function upsertCodexToml(id: string, path: string): McpWrite {
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, 'utf8') : '';
  const section = `${TOML_HEADER}\nurl = ${JSON.stringify(serverEntry().url)}\nbearer_token_env_var = "GRAFT_MCP_TOKEN"\n`;

  const { rest, found } = stripTomlSection(text);
  // Byte-identical already: don't rewrite the file just to reorder it.
  if (found && text === appendSection(rest, section)) return { id, path, action: 'unchanged' };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, appendSection(rest, section));
  return { id, path, action: existed ? 'updated' : 'created' };
}

/** Append a section after exactly one blank line, or at the top of an empty file. */
function appendSection(text: string, section: string): string {
  if (text.trim() === '') return section;
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${section}`;
}

function jsonTarget(
  hostId: string,
  id: string,
  path: string,
  topKey: string,
  entry: object,
  scope: PlannedWrite['scope'] = 'repo',
  defaults?: Record<string, unknown>,
): McpTarget {
  return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.graft`, format: 'json', topKey, entry, defaults };
}

/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export function mcpTargets(
  repo: string,
  ids: string[],
  opts: { home?: string; includeRetired?: boolean; url?: string } = {},
): McpTarget[] {
  const home = opts.home ?? homedir();
  const entry = serverEntry(opts.url ?? DEFAULT_MCP_URL);
  const out: McpTarget[] = [];
  for (const id of ids) {
    switch (id) {
      case 'cursor':
        out.push(jsonTarget(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', { url: entry.url, headers: { Authorization: 'Bearer ${env:GRAFT_MCP_TOKEN}' } }));
        break;
      case 'gemini':
        out.push(jsonTarget(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', { httpUrl: entry.url, headers: entry.headers }));
        break;
      case 'kiro':
        out.push(jsonTarget(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', { url: entry.url, headers: entry.headers }));
        break;
      case 'antigravity':
        if (opts.includeRetired) out.push({ ...jsonTarget(id, id, join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', {}, 'global'), retired: true });
        break;
      case 'muse':
        if (opts.includeRetired) out.push({ ...jsonTarget(id, id, join(home, '.config', 'muse', 'settings.json'), 'mcpServers', {}, 'global'), retired: true });
        break;
      case 'grok':
        if (opts.includeRetired) out.push({ hostId: id, id, path: join(repo, '.grok', 'config.toml'), scope: 'repo', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml', retired: true });
        break; // No verified authenticated Streamable HTTP configuration for these hosts.
      case 'agents':
        // Guarded on the CLI actually being installed, so a plan only ever
        // lists files a real run would touch.
        if (dirExists(join(home, '.codex'))) {
          out.push({
            hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
            scope: 'global', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
          });
        }
        if (dirExists(join(home, '.config', 'opencode'))) {
          out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry(entry.url)));
        }
        break;
      case 'droid':
        // Droid reads HTTP registrations from the project-level mcpServers map.
        out.push(jsonTarget(id, 'droid', join(repo, '.factory', 'mcp.json'), 'mcpServers', entry));
        break;
      default:
        break; // copilot / windsurf / adal / pi / project-agents: no MCP target (pi's own no-MCP stance)
    }
  }
  return out;
}

export function registerMcpConfigs(
  repo: string,
  ids: string[],
  opts: { home?: string; global?: boolean } = {},
): McpWrite[] {
  const reason = mcpSetupReason();
  // Planning is pure; validate the configured URL only when writing a supported target.
  const targets = mcpTargets(repo, ids, { ...opts, includeRetired: true })
    .filter(t => opts.global !== false || t.scope !== 'global');
  const entries = !reason && targets.some(t => !t.retired)
    ? mcpTargets(repo, ids, { ...opts, url: mcpUrl() }) : [];
  return targets.map(t => {
    if (t.retired) return { id: t.id, path: t.path, action: 'skipped',
      reason: 'authenticated HTTP support is unverified; existing registration preserved; use graft CLI' };
    if (reason) return { id: t.id, path: t.path, action: 'skipped', reason };
    const entry = entries.find(entry => entry.id === t.id && entry.path === t.path)!;
    return t.format === 'toml' ? upsertCodexToml(t.id, t.path)
      : mergeJsonKey(t.id, t.path, t.topKey!, entry.entry!, { defaults: t.defaults });
  });
}

export function mcpSetupReason(): string | undefined {
  if (!process.env.GRAFT_MCP_TOKEN || /\s/.test(process.env.GRAFT_MCP_TOKEN))
    return 'start the daemon and export GRAFT_MCP_TOKEN, then run graft init';
}
