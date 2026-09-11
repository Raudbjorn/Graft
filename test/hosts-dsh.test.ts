/**
 * DSH host: a project skill under `.dsh/skills/graft/` plus a `graft:dsh:*`
 * fenced AGENTS.md section.
 *
 * The fence is the interesting part. Every other AGENTS.md host (agents,
 * hermes, antigravity) writes the same CLI-oriented body, so they can share one
 * marker pair; DSH's body teaches the six first-class `graft_*` tools, so it
 * needs markers of its own or the two would overwrite each other in a repo that
 * wires both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, detectHosts } from '../src/hosts/registry.js';
import {
  DSH_SKILL_RELPATH,
  dshInstructionBody,
  dshSkillTargets,
  dshSkillTemplate,
  installDshSkill,
} from '../src/hosts/dsh.js';
import { runHostsInit } from '../src/hosts/init.js';
import { planInit, selectedWrites } from '../src/hosts/plan.js';
import { runRetract, changed } from '../src/hosts/retract.js';
import { DSH_START, DSH_END, GRAFT_MARKERS } from '../src/hosts/sections.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-dsh-')); }

/** The six first-class tools every DSH-facing body has to name. */
const SIX_TOOLS = [
  'graft_find_code',
  'graft_file_api',
  'graft_trace_calls',
  'graft_find_all',
  'graft_repo_map',
  'graft_check_freshness',
];

test('detects on a project .dsh/ and on a user ~/.dsh, not on a bare tree', () => {
  const home = fresh(), repo = fresh();
  const probe = (h: string, r: string) => ({ home: h, repo: r, dirExists: (p: string) => existsSync(p) });
  assert.ok(!detectHosts(probe(home, repo)).some((h) => h.id === 'dsh'), 'bare tree is not DSH');

  mkdirSync(join(repo, '.dsh'));
  assert.ok(detectHosts(probe(home, repo)).some((h) => h.id === 'dsh'), 'project .dsh/ → dsh');

  const home2 = fresh();
  mkdirSync(join(home2, '.dsh'));
  assert.ok(detectHosts(probe(home2, fresh())).some((h) => h.id === 'dsh'), 'user ~/.dsh → dsh');

  assert.equal(HOSTS.find((h) => h.id === 'dsh')?.relPath, 'AGENTS.md');
});

test('both DSH bodies name all six tools and the build bootstrap', () => {
  for (const body of [dshInstructionBody(), dshSkillTemplate()]) {
    for (const tool of SIX_TOOLS) assert.ok(body.includes(tool), `${tool} is named`);
    assert.match(body, /graft build/, 'points at the bootstrap');
    // Tools first, CLI only as the explicit "tools are not in your list" fallback —
    // which must therefore trail the tool guidance, not open the body.
    const fallbackAt = body.search(/(not in your tool list|absent from your tool list)/);
    assert.ok(fallbackAt > body.length / 2, 'the CLI fallback trails the tool guidance');
  }
  // The skill is a model-invocable reference, not a slash command.
  assert.match(dshSkillTemplate(), /^---\nname: graft\n/);
  assert.match(dshSkillTemplate(), /user-invocable: false/);
});

test('installDshSkill writes .dsh/skills/graft/SKILL.md, idempotently', () => {
  const repo = fresh();
  const [target] = dshSkillTargets(repo);
  assert.equal(target.path, join(repo, DSH_SKILL_RELPATH));
  assert.equal(target.scope, 'repo');
  assert.equal(target.kind, 'skill');

  assert.equal(installDshSkill(repo)[0].action, 'created');
  assert.equal(readFileSync(target.path, 'utf8'), dshSkillTemplate());
  assert.equal(installDshSkill(repo)[0].action, 'unchanged', 're-run is a no-op');
});

test('runHostsInit --agents dsh writes AGENTS.md + the skill, and registers no MCP', () => {
  const repo = fresh(), home = fresh();
  const r = runHostsInit(repo, { agents: ['dsh'], home });
  assert.deepEqual(r.written.map((w) => w.id), ['dsh']);

  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(DSH_START) && agents.includes(DSH_END), 'own fence');
  assert.ok(agents.includes('graft_find_code'), 'native guidance, not the CLI body');
  assert.ok(existsSync(join(repo, DSH_SKILL_RELPATH)), 'skill written');
  assert.equal(r.mcp.length, 0, 'DSH needs no MCP config');
  assert.ok(r.hooks.some((w) => w.path.endsWith(join('skills', 'graft', 'SKILL.md'))), 'skill reported');

  // The skill is repo-local, so --no-global must not suppress it.
  const repo2 = fresh();
  const noGlobal = runHostsInit(repo2, { agents: ['dsh'], home: fresh(), global: false });
  assert.ok(existsSync(join(repo2, DSH_SKILL_RELPATH)), 'still written under --no-global');
  assert.equal(noGlobal.mcp.length, 0);
});

test('the DSH fence is separate from the shared graft fence, and both coexist', () => {
  const repo = fresh(), home = fresh();
  runHostsInit(repo, { agents: ['agents', 'dsh'], home });
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');

  const start = agents.split(GRAFT_MARKERS.start).length - 1;
  const dsh = agents.split(DSH_START).length - 1;
  assert.equal(start, 1, 'exactly one shared graft block');
  assert.equal(dsh, 1, 'exactly one DSH block');

  // The CLI body stays inside the shared fence; the tool names live in the DSH one.
  const shared = agents.slice(agents.indexOf(GRAFT_MARKERS.start), agents.indexOf(GRAFT_MARKERS.end));
  assert.ok(shared.includes('graft ask'), 'shared block is the CLI body');
  assert.ok(!shared.includes('graft_find_code'), 'tool guidance is not in the shared block');
});

test('the plan says exactly what init writes for dsh', () => {
  const repo = fresh(), home = fresh();
  const dsh = planInit(repo, { home, ids: ['dsh'] })[0];
  assert.deepEqual(dsh.writes.map((w) => w.kind).sort(), ['instruction', 'skill']);

  const planned = new Set(selectedWrites([dsh], ['dsh']).map((w) => w.path));
  const r = runHostsInit(repo, { agents: ['dsh'], home });
  const actual = new Set([...r.written.map((w) => w.path), ...r.hooks.map((w) => w.path)]);
  assert.deepEqual([...actual].sort(), [...planned].sort());
});

test('uninstall removes the skill and the DSH block, and leaves the user alone', () => {
  const repo = fresh(), home = fresh();
  const agents = join(repo, 'AGENTS.md');
  writeFileSync(agents, '# Notes\n\nMine.\n');
  runHostsInit(repo, { agents: ['dsh'], home });

  const first = changed(runRetract(repo, { apply: true, global: false }));
  assert.ok(first.length > 0, 'init left something to retract');
  assert.ok(!existsSync(join(repo, DSH_SKILL_RELPATH)), 'skill removed');
  const left = readFileSync(agents, 'utf8');
  assert.ok(left.includes('Mine.'), "the user's prose survives");
  assert.ok(!left.includes(DSH_START), 'DSH block stripped');

  // A second sweep finds nothing — no residue, no double-removal.
  assert.deepEqual(changed(runRetract(repo, { apply: true, global: false })), []);
});

test('keeping the dsh host spares the AGENTS.md the other AGENTS.md hosts share', () => {
  const repo = fresh(), home = fresh();
  runHostsInit(repo, { agents: ['agents', 'dsh'], home });
  runRetract(repo, { apply: true, global: false, exclude: ['dsh'] });
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(DSH_START), 'kept host keeps its block');
  assert.ok(existsSync(join(repo, DSH_SKILL_RELPATH)), 'kept host keeps its skill');
});
