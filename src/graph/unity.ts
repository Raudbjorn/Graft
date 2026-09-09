/**
 * Unity asset tier — scenes (`.unity`), prefabs (`.prefab`), asset identity
 * (`.meta`), and meshes (`.fbx`).
 *
 * Unity serializes scenes/prefabs as UnityYAML text: `--- !u!<classID>
 * &<fileID>` documents, references as `{fileID, guid, type}`, asset identity
 * in a sibling `.meta` file's `guid:` line. That maps directly onto the graph:
 * GameObjects/components become nodes, an `m_Script` guid becomes a
 * `references` edge into the already-indexed C# graph (via the `.meta` guid
 * map, resolved whole-repo in resolve.ts), and an `m_Mesh`/`m_SourcePrefab`
 * guid becomes a prefab → FBX-file → scene chain.
 *
 * Deliberately NOT a tree-sitter tier (depth or breadth): stock YAML grammars
 * cannot parse the custom `!u!` tags, so this is a hand-written splitter on
 * `--- !u!` document boundaries plus `{fileID, guid}` ref extraction — the
 * same approach existing Unity tooling uses. Binary-serialized scenes (a real
 * corpus has them: magic bytes, NULs) and unparseable FBX degrade to a file
 * node, never a build failure. Dangling `m_Script` guids (deleted scripts)
 * resolve to an `unresolved:<guid>` edge target in resolve.ts, never a crash.
 *
 * Non-goals: prefab variants/overrides, Timeline/Shader Graph, the `--deep`
 * LLM tier (these nodes carry `summary_state: "pending"` like every Tier-1
 * node and are simply never summarized without `--deep`).
 */
import { contentHash } from "../util/id.js";
import type { RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

/** Which Unity shape a path holds. `.meta` only counts when its sibling asset
 * is a linkable type (a script, mesh, prefab, or scene) — every imported file
 * in a Unity project has a `.meta`, and indexing all of them would bury the
 * graph in texture/material identity nodes nothing resolves into. */
export type UnityKind = "scene" | "prefab" | "meta" | "fbx";

/** Sibling asset extensions whose `.meta` files are indexed (the guid map only
 * ever resolves into these). */
const LINKABLE_SIBLINGS = new Set([".cs", ".fbx", ".prefab", ".unity"]);

/** The Unity shape for a path, or null when no Unity tier claims it. */
export function unityLangOf(path: string): UnityKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".unity")) return "scene";
  if (lower.endsWith(".prefab")) return "prefab";
  if (lower.endsWith(".fbx")) return "fbx";
  if (lower.endsWith(".meta")) {
    const sibling = lower.slice(0, -".meta".length);
    for (const ext of LINKABLE_SIBLINGS) if (sibling.endsWith(ext)) return "meta";
  }
  return null;
}

/** Every file extension the Unity tier claims. */
export function unityExtensions(): string[] {
  return [".unity", ".prefab", ".meta", ".fbx"];
}

/** Display label for the build banner — one tier, one name. */
export const UNITY_LABEL = "unity";

/** `guid:` line of a `.meta` file (32 lowercase hex). */
const META_GUID_RE = /^guid:\s*([0-9a-f]{32})\s*$/m;

/** Parse a `.meta` file's asset guid, or null when it carries none. Exported
 * so tests can pin the identity half of the guid map without a full build. */
export function parseMetaGuid(source: string): string | null {
  return META_GUID_RE.exec(source)?.[1] ?? null;
}

/** One UnityYAML document: `--- !u!<classID> &<fileID>` plus its body lines.
 * `startLine`/`endLine` are 1-based over the whole file, so node spans point
 * at the exact document (graft's promise is that `file:line` is exact). */
export interface UnityDoc {
  classId: number;
  fileId: string;
  startLine: number;
  endLine: number;
  body: string;
}

const DOC_HEADER_RE = /^--- !u!(\d+)\s*&(\d+)\s*(stripped)?\s*$/;

/** Split UnityYAML text into documents. Returns null for binary-serialized
 * files (NUL bytes — a real corpus has them) so callers degrade to file-only. */
export function splitUnityDocs(source: string): UnityDoc[] | null {
  if (source.includes("\0")) return null;
  const lines = source.split("\n");
  const docs: UnityDoc[] = [];
  let cur: { classId: number; fileId: string; startLine: number } | null = null;
  let bodyStart = 0;
  const close = (endLine: number) => {
    if (!cur) return;
    docs.push({
      classId: cur.classId,
      fileId: cur.fileId,
      startLine: cur.startLine,
      endLine,
      body: lines.slice(bodyStart, endLine).join("\n"),
    });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = DOC_HEADER_RE.exec(lines[i].trimEnd());
    if (m) {
      close(i); // `i` is 0-based: endLine of the previous doc is this line number
      cur = { classId: Number(m[1]), fileId: m[2], startLine: i + 1 };
      bodyStart = i + 1;
    }
  }
  close(lines.length);
  return docs;
}

/** `{fileID: N}` or `{fileID: N, guid: G, type: T}` — the only ref shape. */
const REF_RE = /\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-f]{32}),\s*type:\s*(\d+))?\}/g;

/** Line-scoped cross-asset refs that become edges. `m_Script` is the
 * GameObject→component→script edge; `m_Mesh` is prefab→FBX; `m_SourcePrefab`
 * is scene→prefab. Every other guid in the file (materials, textures,
 * Estates) is out of scope for this tier — each would otherwise become an
 * `unresolved:` edge on scenes with hundreds of refs.
 *
 * Each ref emits TWO edges: a file-level one (the dependency fact — this is
 * what keeps multi-hop `callers` connected across the prefab boundary, since
 * scene→prefab lands on the prefab's file node) and, when the ref lives in a
 * doc owned by an emitted node, an owner-level one from the component or
 * GameObject (the precise `file:line`). `m_SourcePrefab` has no node for its
 * doc, so it is file-level only. */
const EDGE_KEYS = new Set(["m_Script", "m_Mesh", "m_SourcePrefab"]);

interface DocRef {
  key: string;
  fileId: string;
  guid: string | null;
  line: number; // 1-based file line, for future quote support
}

const CLASS_MONO_BEHAVIOUR = 114;
const CLASS_GAME_OBJECT = 1;

/** All `{fileID, guid}` refs on edge-carrying lines of one document. */
function docRefs(doc: UnityDoc): DocRef[] {
  const out: DocRef[] = [];
  const lines = doc.body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const keyM = /^\s*([A-Za-z_][\w]*)\s*:/.exec(lines[i]);
    if (!keyM || !EDGE_KEYS.has(keyM[1])) continue;
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(lines[i])) !== null) {
      out.push({ key: keyM[1], fileId: m[1], guid: m[2] ?? null, line: doc.startLine + 1 + i });
    }
  }
  return out;
}

/** First `key:` value's leading scalar on its line (`m_Name: Bed_1`). */
function docScalar(doc: UnityDoc, key: string): string | null {
  // Horizontal-only whitespace: `\s` matches newlines, which leaked an empty
  // value onto the next line (`m_EditorClassIdentifier: ` captured `occupant:
  // {fileID: 0}`), poisoning guid resolution with a garbage class name.
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(\\S[^\\n]*)?[ \\t]*$`, "m").exec(doc.body);
  if (!m || m[1] === undefined) return null;
  return m[1].trim() || null;
}

/** `m_EditorClassIdentifier: LocalScript::CatBed` → `CatBed`. Unity writes the
 * script class here when it knows it; empty/absent (deleted or moved scripts)
 * means the guid alone identifies the target. */
export function scriptClassOf(identifier: string | null): string | null {
  if (!identifier) return null;
  const sep = identifier.lastIndexOf("::");
  const afterScope = sep === -1 ? identifier : identifier.slice(sep + 2);
  const cls = afterScope.slice(afterScope.lastIndexOf(".") + 1).trim();
  return cls || null;
}

function fileNode(rel: string, source: string, residual: string): NodeV1 {
  return {
    id: rel,
    name: rel.split("/").pop() ?? rel,
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`,
    signature: null,
    exported: true,
    origin: "ast", // hand-written, full-fidelity: refs carry guid+class, not bare names
    body_hash: contentHash(source),
    chars: source.length,
    body_text: residual,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function contains(source: string, targetId: string, file: string): RawEdge {
  return { source, relation: "contains", file, targetId };
}

/**
 * Extract one UnityYAML scene/prefab file, or one `.meta` identity file.
 * Never throws: a binary scene, a guid-less `.meta`, or a doc without names
 * all degrade to fewer nodes — a build must not fail over one asset.
 */
export function extractUnityFile(rel: string, source: string, kind: UnityKind): { nodes: NodeV1[]; rawEdges: RawEdge[] } {
  if (kind === "meta") {
    const guid = parseMetaGuid(source);
    const node = fileNode(rel, source, guid ? `guid:${guid}` : "");
    node.signature = guid ? `guid:${guid}` : null;
    return { nodes: [node], rawEdges: [] };
  }

  const docs = splitUnityDocs(source);
  if (docs === null) return { nodes: [fileNode(rel, source, "")], rawEdges: [] };

  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const residuals: string[] = [];

  // Index GameObject docs first: components link to them via `m_GameObject`.
  const goNameByFileId = new Map<string, string>();
  const goIdByFileId = new Map<string, string>();
  for (const doc of docs) {
    if (doc.classId !== CLASS_GAME_OBJECT) continue;
    const name = docScalar(doc, "m_Name") ?? `GameObject&${doc.fileId}`;
    const id = mint(rel, `${name}`, minted);
    goNameByFileId.set(doc.fileId, name);
    goIdByFileId.set(doc.fileId, id);
    residuals.push(name);
    nodes.push({
      id,
      name,
      kind: "module", // a named container of components — the Swift-extension precedent
      path: rel,
      span: `L${doc.startLine}-L${doc.endLine}`,
      signature: `GameObject ${name}`,
      exported: false,
      origin: "ast",
      body_hash: contentHash(doc.body),
      body_text: name,
      summary_state: "pending",
      summary: null,
      crux: null,
    });
    rawEdges.push(contains(rel, id, rel));
  }

  for (const doc of docs) {
    if (doc.classId === CLASS_GAME_OBJECT) continue;
    const goFileId = /^\s*m_GameObject:\s*\{fileID:\s*(-?\d+).*?\}/m.exec(doc.body)?.[1];
    const goId = (goFileId && goIdByFileId.get(goFileId)) ?? rel;
    const goName = (goFileId && goNameByFileId.get(goFileId)) ?? null;
    const refs = docRefs(doc);

    if (doc.classId === CLASS_MONO_BEHAVIOUR) {
      const cls = scriptClassOf(docScalar(doc, "m_EditorClassIdentifier"));
      const name = cls ?? `MonoBehaviour&${doc.fileId}`;
      const id = mint(rel, `${goName ?? "Scene"}.${cls ?? `MonoBehaviour&${doc.fileId}`}`, minted);
      residuals.push(cls ?? name);
      nodes.push({
        id,
        name,
        kind: "variable", // an instance slot holding a script reference
        path: rel,
        span: `L${doc.startLine}-L${doc.endLine}`,
        signature: cls ? `MonoBehaviour ${cls} on ${goName ?? "scene"}` : `MonoBehaviour on ${goName ?? "scene"}`,
        exported: false,
        origin: "ast",
        body_hash: contentHash(doc.body),
        body_text: [name, goName ?? ""].join(" ").trim(),
        summary_state: "pending",
        summary: null,
        crux: null,
      });
      rawEdges.push(contains(goId, id, rel));
      for (const ref of refs) {
        if (ref.key !== "m_Script" || !ref.guid) continue;
        // The guid resolves whole-repo in resolve.ts (guid map from `.meta`
        // nodes); `name` scopes it to the mapped file, with a global-unique
        // fallback for renamed classes. Never crashes on dangling guids —
        // those become `unresolved:<guid>` edge targets there.
        const edge = { relation: "references", file: rel, name: cls ?? undefined, unityGuid: ref.guid } as const;
        rawEdges.push({ source: id, ...edge });
        rawEdges.push({ source: rel, ...edge });
      }
      continue;
    }

    // Non-component docs: PrefabInstance source links come from the file node;
    // mesh (and future asset) refs ride on their GameObject when linked, plus
    // the file-level chain link described above.
    for (const ref of refs) {
      if (!ref.guid) continue;
      if (ref.key === "m_SourcePrefab") {
        rawEdges.push({ source: rel, relation: "references", file: rel, unityGuid: ref.guid });
        continue;
      }
      rawEdges.push({ source: goId, relation: "references", file: rel, unityGuid: ref.guid });
      if (goId !== rel) rawEdges.push({ source: rel, relation: "references", file: rel, unityGuid: ref.guid });
    }
  }

  nodes.unshift(fileNode(rel, source, residuals.join(" ")));
  return { nodes, rawEdges };
}

/** Mint-time uniqueness within one file (duplicate GameObject names are
 * routine in scenes): `Name`, then `Name~2`, `Name~3`, … — the same shape as
 * extract.ts's {@link mintId}, scoped here so the Unity tier stays
 * dependency-free of tree-sitter. */
function mint(rel: string, name: string, minted: Set<string>): string {
  let id = `${rel}#${name}`;
  for (let n = 2; minted.has(id); n++) id = `${rel}#${name}~${n}`;
  minted.add(id);
  return id;
}

// --- FBX -------------------------------------------------------------------

const FBX_MAGIC = "Kaydara FBX Binary  ";
const FBXmodel = "Model";

/** Object names (`Model::Sofa`) of a binary FBX, ported from the sandbox's
 * `fbx_stats.py` (same record walk) minus everything needing decompression:
 * skipping an array property only needs its byte length, never its contents.
 * Returns null for non-binary (ASCII) FBX — those go through {@link fbxAsciiModels}. */
export function fbxBinaryModels(bytes: Uint8Array): string[] | null {
  try {
    const magic = new TextDecoder("latin1").decode(bytes.subarray(0, 20));
    if (magic !== FBX_MAGIC) return null;
    const r = new FbxReader(bytes);
    r.pos = 23;
    const version = r.u32();
    r.wide = version >= 7500;
    const names: string[] = [];
    for (;;) {
      if (r.left() <= 13) break;
      const node = r.node();
      if (!node) break;
      collectModels(node, names);
    }
    return names;
  } catch {
    return null; // truncated or malformed FBX — file node only, never fatal
  }
}

interface FbxNode {
  name: string;
  props: FbxProp[];
  kids: FbxNode[];
}

type FbxProp = number | string | null; // arrays skipped (null), scalars decoded

class FbxReader {
  pos: number;
  wide = false;
  constructor(private b: Uint8Array) {
    this.pos = 0;
  }
  left(): number {
    return this.b.length - this.pos;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new Error("fbx: truncated");
    const s = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u32(): number {
    const [a, b, c, d] = this.take(4);
    return a | (b << 8) | (c << 16) | d * 0x1000000;
  }
  u64(): number {
    const lo = this.u32();
    const hi = this.u32();
    return lo + hi * 0x100000000;
  }
  off(): number {
    return this.wide ? this.u64() : this.u32();
  }
  str(n: number): string {
    return new TextDecoder("latin1").decode(this.take(n));
  }
  prop(): FbxProp {
    const t = String.fromCharCode(this.u8());
    switch (t) {
      case "Y":
        this.take(2);
        return 0;
      case "C":
        this.take(1);
        return 0;
      case "I":
      case "F":
        this.take(4);
        return 0;
      case "D":
      case "L":
        this.take(8);
        return 0;
      case "f":
      case "d":
      case "l":
      case "i":
      case "b": {
        const count = this.u32();
        const enc = this.u32();
        const len = this.u32();
        void count;
        void enc;
        this.take(len); // skip without decompressing — names never live here
        return null;
      }
      case "S":
      case "R": {
        const len = this.u32();
        return this.str(len);
      }
      default:
        throw new Error(`fbx: unknown property type ${t}`);
    }
  }
  node(): FbxNode | null {
    const end = this.off();
    const nprop = this.off();
    this.off(); // property byte length — subsumed by `end`
    if (end === 0) return null;
    const nameLen = this.u8();
    const name = this.str(nameLen);
    const props: FbxProp[] = [];
    for (let i = 0; i < nprop; i++) props.push(this.prop());
    const kids: FbxNode[] = [];
    const floor = this.wide ? 25 : 13;
    while (this.pos + floor < end && this.pos < end) {
      const kid = this.node();
      if (!kid) break;
      kids.push(kid);
    }
    this.pos = end;
    return { name, props, kids };
  }
}

function fbxObjectName(raw: string): string {
  return raw.split("\0")[0].trim();
}

function collectModels(node: FbxNode, out: string[]): void {
  if (node.name === FBXmodel && typeof node.props[1] === "string") {
    const name = fbxObjectName(node.props[1]);
    if (name) out.push(name);
  }
  for (const k of node.kids) collectModels(k, out);
}

/** `Model: 123, "Model::Sofa", "Mesh" {` lines of an ASCII FBX export. */
const FBX_ASCII_MODEL_RE = /^Model:\s*\d+,\s*"([^"]+)"\s*,/gm;

/** Object names of an ASCII FBX file (null when it has none). */
export function fbxAsciiModels(source: string): string[] | null {
  if (source.includes("\0")) return null;
  const out: string[] = [];
  FBX_ASCII_MODEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FBX_ASCII_MODEL_RE.exec(source)) !== null) {
    const name = m[1].split("\0")[0].trim();
    if (name) out.push(name);
  }
  return out.length > 0 ? out : null;
}

/**
 * Extract one `.fbx` mesh file: a file node plus one node per Model object
 * name (binary via the ported reader, ASCII via line regex). `bytes` is the
 * raw file for the binary walk; `source` is the same file as text, whose hash
 * is the node identity (so build, check, and the fingerprint probe — which all
 * read through `readSourceFile` — agree byte-for-byte).
 */
export function extractFbxFile(
  rel: string,
  source: string,
  bytes: Uint8Array,
): { nodes: NodeV1[]; rawEdges: RawEdge[] } {
  let models = fbxBinaryModels(bytes);
  models ??= fbxAsciiModels(source) ?? [];
  const seen = new Set<string>();
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  for (const full of models) {
    const sep = full.lastIndexOf("::");
    const short = sep === -1 ? full : full.slice(sep + 2);
    const name = short || full;
    if (seen.has(name)) continue;
    seen.add(name);
    const id = mint(rel, name, minted);
    nodes.push({
      id,
      name,
      kind: "module", // a named scene-graph object, like a GameObject
      path: rel,
      span: "L1-L1", // binary has no lines; the model table is the file
      signature: full === name ? `Model ${name}` : `Model ${full}`,
      exported: false,
      origin: "ast",
      body_hash: contentHash(`${rel}\0${name}`),
      body_text: `${full} ${name}`,
      summary_state: "pending",
      summary: null,
      crux: null,
    });
    rawEdges.push(contains(rel, id, rel));
  }
  nodes.unshift(fileNode(rel, source, models.join(" ")));
  // The FBX file node spans the "text" decoding of binary — pin it to L1-L1 so
  // a binary blob never claims thousands of phantom lines.
  nodes[0].span = "L1-L1";
  return { nodes, rawEdges };
}
