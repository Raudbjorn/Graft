/**
 * Registry of AI coding hosts Graft can write instructions for.
 * Adding a host = adding one entry here (plus a renderer if it needs
 * a new file format).
 *
 * kind: 'section' → upsert the fenced block into a shared file the user owns.
 * kind: 'owned'   → graft owns the whole file; overwrite it each run.
 */
import { join } from 'node:path';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from './instructions.js';
import { dshInstructionBody } from './dsh.js';
import { DSH_MARKERS, type Markers } from './sections.js';
import { skillTemplate } from '../claude/skill-template.js';

export interface DetectProbe {
  home: string;
  repo: string;
  dirExists(path: string): boolean;
}

export interface HostTarget {
  id: string;
  name: string;
  kind: 'section' | 'owned';
  /** Target file, relative to the repo root. */
  relPath: string;
  content(): string;
  /**
   * For `kind: 'section'`, the fence this host owns. Omitted means the shared
   * `graft:start` pair, which is right for every AGENTS.md host that writes the
   * same body (agents, hermes, antigravity — whichever runs last is still
   * correct). A host whose body genuinely differs must bring its own pair, or
   * the two would silently overwrite each other in a repo that wires both.
   */
  markers?: Markers;
  detect(probe: DetectProbe): boolean;
}

export const HOSTS: HostTarget[] = [
  {
    id: 'agents',
    name: 'AGENTS.md hosts (Codex-style CLIs, editors that read AGENTS.md)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    detect: (p) =>
      p.dirExists(join(p.home, '.codex')) ||
      p.dirExists(join(p.home, '.config', 'opencode')) ||
      p.dirExists(join(p.home, '.config', 'agents')),
  },
  {
    id: 'adal',
    name: 'AdaL',
    kind: 'owned',
    relPath: join('.adal', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.adal')) || p.dirExists(join(p.repo, '.adal')),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'owned',
    relPath: join('.cursor', 'rules', 'graft.mdc'),
    content: cursorRule,
    detect: (p) => p.dirExists(join(p.home, '.cursor')) || p.dirExists(join(p.repo, '.cursor')),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    kind: 'section',
    relPath: 'GEMINI.md',
    content: instructionBody,
    detect: (p) => p.dirExists(join(p.home, '.gemini')),
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    kind: 'owned',
    relPath: join('.grok', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.grok')) || p.dirExists(join(p.repo, '.grok')),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent (Nous Research)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    // Hermes is repo-aware: it reads AGENTS.md at the repo root (and the
    // Graft-for-Hermes plugin keeps the graph fresh on every session start).
    detect: (p) =>
      p.dirExists(join(p.home, '.hermes')) ||
      p.dirExists(join(p.home, 'AppData', 'Local', 'hermes')) ||
      p.dirExists(join(p.repo, '.hermes')),
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    // Antigravity-specific markers, NOT the bare `~/.gemini` (which is also Gemini CLI's):
    // its global config dir (`~/.gemini/config/`, where mcp_config.json + hooks.json live)
    // or a workspace `.agents/` dir. Keeps a plain Gemini-CLI user from auto-selecting it.
    detect: (p) =>
      p.dirExists(join(p.home, '.gemini', 'config')) ||
      p.dirExists(join(p.home, '.gemini', 'antigravity-cli')) ||
      p.dirExists(join(p.repo, '.agents')),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    kind: 'section',
    relPath: join('.github', 'copilot-instructions.md'),
    content: instructionBody,
    detect: (p) => p.dirExists(join(p.repo, '.github')),
  },
  {
    id: 'kiro',
    name: 'Kiro',
    kind: 'owned',
    relPath: join('.kiro', 'steering', 'graft.md'),
    content: kiroSteering,
    detect: (p) => p.dirExists(join(p.home, '.kiro')) || p.dirExists(join(p.repo, '.kiro')),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'owned',
    relPath: join('.windsurf', 'rules', 'graft.md'),
    content: windsurfRule,
    detect: (p) => p.dirExists(join(p.home, '.codeium', 'windsurf')) || p.dirExists(join(p.repo, '.windsurf')),
  },
  {
    // Droid reads AGENTS.md (docs.factory.ai/harness/agents-md.md) — the same
    // file as the 'agents' row, so selecting both runs two identical upserts
    // and the second reports 'unchanged'. Its own row exists for detection
    // (the ~/.factory install probe) and the MCP target (.factory/mcp.json).
    id: 'droid',
    name: 'Droid (Factory CLI)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    detect: (p) => p.dirExists(join(p.home, '.factory')) || p.dirExists(join(p.repo, '.factory')),
  },
  {
    // Pi has no MCP support by design (its README: "No MCP" — CLI tools and
    // skills are the extension surface), so wiring is the skill file alone:
    // pi discovers `.pi/skills/` from the cwd upward, alongside AGENTS.md.
    id: 'pi',
    name: 'Pi Coding Agent',
    kind: 'owned',
    relPath: join('.pi', 'skills', 'graft', 'SKILL.md'),
    content: skillTemplate,
    detect: (p) => p.dirExists(join(p.home, '.pi')) || p.dirExists(join(p.repo, '.pi')),
  },
  {
    // The vendor-neutral convention row: every agent that reads project-level
    // STANDARD files — AGENTS.md plus the Agent-Skills `.agents/skills/`
    // location (droid's documented compatibility scope, pi's documented skill
    // dir, Codex-style CLIs' instruction file) — wires from this one row, and
    // a future standard-reading tool needs no registry entry. Strictly
    // project-scoped: machine-wide and vendor-specific config stays with each
    // vendor's own row (the agents row's ~/.codex writes, droid's MCP).
    // Detection: any installed agent in the standard-reading family, or a repo
    // that already carries the `.agents/` convention.
    id: 'project-agents',
    name: 'Project-standard agents (AGENTS.md + .agents/skills)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: instructionBody,
    detect: (p) =>
      p.dirExists(join(p.home, '.codex')) ||
      p.dirExists(join(p.home, '.config', 'opencode')) ||
      p.dirExists(join(p.home, '.factory')) ||
      p.dirExists(join(p.home, '.pi')) ||
      p.dirExists(join(p.repo, '.agents')),
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness (DSH)',
    kind: 'section',
    relPath: 'AGENTS.md',
    content: dshInstructionBody,
    // Its own fence: DSH's body teaches the six native `graft_*` tools, while
    // every other AGENTS.md host writes the CLI-oriented body. See DSH_MARKERS.
    markers: DSH_MARKERS,
    // `.dsh/` in the repo is DSH's project config root and `~/.dsh` is its user
    // root, so either one means the user runs DSH. Deliberately not `AGENTS.md`
    // alone: every Codex-style host reads that file too. The companion skill
    // write (`.dsh/skills/graft/SKILL.md`) lives in `./dsh.js`, not in this
    // entry's `relPath` — see that module for why the split is deliberate.
    detect: (p) => p.dirExists(join(p.repo, '.dsh')) || p.dirExists(join(p.home, '.dsh')),
  },
];

export function hostIds(): string[] {
  return HOSTS.map((h) => h.id);
}

export function detectHosts(probe: DetectProbe): HostTarget[] {
  return HOSTS.filter((h) => h.detect(probe));
}
