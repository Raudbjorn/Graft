/**
 * DeepSeek Harness (DSH) support.
 *
 * DSH reads project instructions from `AGENTS.md` and discovers project skills
 * under `.dsh/skills/<name>/SKILL.md`, so wiring it is two repo-local writes:
 *
 *  - `.dsh/skills/graft/SKILL.md` — a graft-owned file, rewritten wholesale when
 *    its content changes (the same contract as Cursor's rule and Kiro's
 *    steering file).
 *  - an `AGENTS.md` section — marker-fenced, in a file the user owns.
 *
 * The registry entry in `registry.ts` owns the AGENTS.md half; this module owns
 * the skill half plus both bodies. That split mirrors `antigravity.ts` (a
 * registry section plus a separate skill installer), and it is what lets
 * `plan.ts`, `init.ts` and `retract.ts` derive every DSH path from one place.
 *
 * DSH's AGENTS.md block gets its OWN marker pair (`graft:dsh:*`, see
 * `sections.ts`) rather than sharing `graft:start` with the agents/hermes/
 * antigravity hosts: those three write byte-identical CLI-oriented bodies, so
 * whichever runs last is still correct, while DSH's body teaches the six
 * first-class `graft_*` tools instead. Sharing the markers would let the two
 * bodies silently overwrite each other in a repo that wires both — the one way
 * those sections are *not* interchangeable.
 *
 * `--deep` (LLM-written node summaries) is deliberately out of scope for the
 * DSH path: the six tools below are tree-sitter-only, $0, and need no provider
 * key, which is exactly what DSH can wire natively.
 */
import { join } from 'node:path';
import { writeOwned, type ConfigWrite } from './config-write.js';
import type { PlannedWrite } from './plan.js';

/** The owned skill file, relative to the repo root. */
export const DSH_SKILL_RELPATH = join('.dsh', 'skills', 'graft', 'SKILL.md');

/** The files installing the DSH layer would touch — pure, no writes. */
export function dshSkillTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'dsh', id: 'dsh-skill',
      path: join(repo, DSH_SKILL_RELPATH),
      scope: 'repo', kind: 'skill', what: 'graft skill (project)',
    },
  ];
}

/** Write `.dsh/skills/graft/SKILL.md`, idempotently. */
export function installDshSkill(repo: string): ConfigWrite[] {
  const target = dshSkillTargets(repo)[0];
  return [writeOwned('dsh-skill', target.path, dshSkillTemplate())];
}

/**
 * The `AGENTS.md` section for a DSH project.
 *
 * Written for a session that HAS the native tools (the `@clintwood/dsh-graft`
 * profile layer): it names the six tools and says when each one applies, so the
 * model picks the right one instead of re-deriving graft's CLI surface. The
 * one-line CLI fallback at the end covers the profile where the layer is not
 * installed and the tools therefore are not in the tool list.
 */
export function dshInstructionBody(): string {
  return `## Graft — repo context graph (DSH)

This repo is indexed in \`graft/\`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code. \`graft/\` is a
regenerable local cache — never commit it, never hand-edit it; the source files
are the truth.

Six native tools answer from that graph. All are $0 and deterministic
(tree-sitter only — no model call, no API key):

- \`graft_repo_map\` — orientation: directory clusters, per-directory hubs, global
  hotspots. New to this repo? Start here.
- \`graft_find_code\` — ranked retrieval in plain words, with the relevant source
  spans inlined. The top hit is usually the whole answer.
- \`graft_file_api\` — one file's signatures and spans, ~10× cheaper than reading
  the file.
- \`graft_find_all\` — exhaustive regex over indexed files, grouped by enclosing
  symbol and ranked by coupling. Use it when "every occurrence" is the question.
- \`graft_trace_calls\` — exact who-calls-what edges for a symbol:
  \`direction:"out"\` for callees, \`depth>1\` (or \`"all"\`) for the full blast
  radius before a refactor.
- \`graft_check_freshness\` — whether the graph is still in sync with the code.

Reach for graft before grepping or opening source files, and open a file only at
the exact file:line a node points to. No graph yet? \`graft build\` creates one
(deterministic, no key); rebuild after large changes. If the \`graft_*\` tools are
not in your tool list, the same six answers come from the \`graft\` CLI — \`graft
ask "<question>" --source\`, \`grep\`, \`skeleton\`, \`callers\`, \`map\`, \`check\`.`;
}

/**
 * The project skill DSH discovers at `.dsh/skills/graft/SKILL.md`.
 *
 * A skill is loaded on demand, so it can afford the per-tool detail the
 * always-on AGENTS.md section cannot: what each tool returns, when it is the
 * wrong one, and the freshness contract between graph and source.
 */
export function dshSkillTemplate(): string {
  return `---
name: graft
description: This repo is indexed by graft/. For ANY task here — understanding
  how something works, finding where code lives, tracing what calls a symbol or
  what a change breaks, or scoping an edit — answer from the graft context graph
  with the graft_* tools before grepping or opening source files.
whenToUse: The session's tool list carries graft_find_code / graft_repo_map /
  graft_trace_calls, or a graft/ directory exists at the repo root.
user-invocable: false
---

# graft

\`graft/\` holds a graph of this repo: small markdown nodes that each explain one
part in prose and name the exact \`file:line\` spans they cover, plus a wiring
graph of who-calls-what. Querying the graph costs a few hundred tokens; rebuilding
that understanding by reading source costs thousands and misses the edges.

It is a **regenerable local cache**, not a source of truth and not something to
commit: \`graft build\` writes it, the tools keep it in sync with your edits, and
deleting it loses nothing. The source files are the truth — when a hit cites a
span you intend to change, open that exact file:line before editing.

## The six tools

Every one is $0, needs no API key, and returns in under a second. **Pick the tool
that fits the task, act on the answer; don't chain them hoping for more. Most
tasks need one call.**

### 1 · \`graft_find_code\` — locate and understand (the default)
Ranked retrieval, routed between prose nodes and the wiring graph, with the
relevant source inlined at each hit (\`full: true\` for whole definitions instead
of the default ≤8-line crux).
**Use when** the question is conceptual or locational: "how does auth work",
"where is rate-limiting handled". \`in\` narrows to a path prefix before scoring.
One call usually answers; a genuinely multi-part question needs one call per
distinct sub-aspect, never the same question reworded.

### 2 · \`graft_find_all\` — exhaustive find
Regex (or a literal with \`fixed: true\`) over every indexed file, hits grouped by
enclosing symbol and ranked by coupling.
**Use when** you need every occurrence: all call sites, all uses of a constant.
\`graft_find_code\` is ranked top-N and *will* miss instances; this will not. Search
a short symbol name or literal, not a guessed full signature; if it misses, loosen
the pattern rather than falling back to raw \`grep -rn\`.

### 3 · \`graft_file_api\` — one file's API at a glance
Signatures-only view of a file (every definition with its span), ~10× cheaper than
reading it.
**Use when** you need "what's in this file / what can I call here" before editing
or wiring into it.

### 4 · \`graft_trace_calls\` — the wiring graph
Exact edges for a symbol. Defaults to callers (\`direction: "in"\`); \`direction:
"out"\` gives callees; \`depth\` > 1 (or \`"all"\` for the full connected closure)
walks transitively.
**Use when** the question is structural — "who calls this", "what breaks if I
change it" — and run it before a multi-file refactor to find every affected file.

### 5 · \`graft_repo_map\` — orientation
Token-budgeted repo overview: directory clusters, per-directory hubs, global
hotspots, computed from the wiring graph.
**Use when** you are new to the repo or to a subsystem.

### 6 · \`graft_check_freshness\` — is the graph in sync?
Reports drift between the committed graph and the code. Unlike the other five it
does NOT refresh first — reporting drift is its entire job.

## Discipline

- Prefer graft over \`grep -rn\` and whole-file reads; the ranked hit usually IS
  the answer, including the code span.
- No graph yet? \`graft build\` creates one — deterministic, no key, $0. After
  large code changes, rebuild (this is also what a fresh clone needs, and
  \`graft build\` gitignores \`graft/\` for you).
- If the \`graft_*\` tools are absent from your tool list, the profile layer that
  registers them is not installed: use the \`graft\` CLI through a shell
  (\`graft ask\`, \`graft grep\`, \`graft skeleton\`, \`graft callers\`, \`graft map\`,
  \`graft check\`).
`;
}
