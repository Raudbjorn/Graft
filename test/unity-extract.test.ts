/**
 * Unity asset tier (DEV-99): UnityYAML scenes/prefabs, `.meta` guid identity,
 * and FBX model names.
 *
 * Small inline fixtures cover: `--- !u!` document splitting (stock YAML
 * grammars cannot parse `!u!` tags, so this is hand-rolled), the guid→asset
 * map, GameObject→component→`m_Script` edges into the C# (depth-tier) graph,
 * prefab → FBX-file → scene linkage, and dangling-guid tolerance (deleted
 * scripts become `unresolved:<guid>` edge targets — never a crash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { callersOf, impactOf } from "../src/graph/traverse.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import {
  extractFbxFile,
  extractUnityFile,
  fbxAsciiModels,
  fbxBinaryModels,
  parseMetaGuid,
  scriptClassOf,
  splitUnityDocs,
  unityLangOf,
} from "../src/graph/unity.js";
import { tmpRepo } from "./helpers.js";

const SCRIPT_GUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MESH_GUID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PREFAB_GUID = "cccccccccccccccccccccccccccccccc";
const DANGLING_GUID = "dddddddddddddddddddddddddddddddd";
const SOLO_GUID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Bed_1
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}
  m_EditorClassIdentifier: Assembly-CSharp::CatBed
--- !u!114 &201
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${DANGLING_GUID}, type: 3}
--- !u!114 &202
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${SOLO_GUID}, type: 3}
--- !u!33 &300
MeshFilter:
  m_GameObject: {fileID: 100}
  m_Mesh: {fileID: 4300000, guid: ${MESH_GUID}, type: 2}
`;

const SCENE = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_Name: Room
--- !u!1001 &20
PrefabInstance:
  m_SourcePrefab: {fileID: 100100000, guid: ${PREFAB_GUID}, type: 3}
`;

const CATBED_CS = `public class CatBed : MonoBehaviour
{
}
`;

const SOLO_CS = `public class Solo : MonoBehaviour
{
}
`;

function metaFor(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\n`;
}

test("unityLangOf routes Unity shapes (and only linkable .meta siblings)", () => {
  assert.equal(unityLangOf("Assets/Bed_1.prefab"), "prefab");
  assert.equal(unityLangOf("Assets/Room.unity"), "scene");
  assert.equal(unityLangOf("Assets/BedMesh.fbx"), "fbx");
  assert.equal(unityLangOf("Assets/CatBed.cs.meta"), "meta");
  assert.equal(unityLangOf("Assets/Bed_1.prefab.meta"), "meta");
  assert.equal(unityLangOf("Assets/icon.png.meta"), null); // not a link target
  assert.equal(unityLangOf("Assets/CatBed.cs"), null); // depth/breadth tiers own it
  assert.equal(unityLangOf("src/main.ts"), null);
});

test("scriptClassOf reads m_EditorClassIdentifier (or its absence)", () => {
  assert.equal(scriptClassOf("Assembly-CSharp::CatBed"), "CatBed");
  assert.equal(scriptClassOf("LocalScript::CatBed"), "CatBed");
  assert.equal(scriptClassOf("UnityEngine.Rendering.Universal.UniversalAdditionalLightData"), "UniversalAdditionalLightData");
  assert.equal(scriptClassOf(null), null);
  assert.equal(scriptClassOf(""), null);
});

test("splitUnityDocs splits on --- !u! boundaries with exact spans", () => {
  const docs = splitUnityDocs(PREFAB)!;
  assert.equal(docs.length, 5);
  assert.deepEqual(
    docs.map((d) => [d.classId, d.fileId, d.startLine, d.endLine]),
    [
      [1, "100", 3, 5],
      [114, "200", 6, 10],
      [114, "201", 11, 14],
      [114, "202", 15, 18],
      [33, "300", 19, 23],
    ],
  );
});

test("splitUnityDocs degrades binary scenes to null (file node only)", () => {
  assert.equal(splitUnityDocs("binary\0blob\0--- !u!1 &1\n"), null);
  const { nodes, rawEdges } = extractUnityFile("Assets/HomeScene.unity", "binary\0blob", "scene");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "file");
  assert.deepEqual(rawEdges, []);
});

test("extractUnityFile emits GameObject + component nodes with contains edges", () => {
  const { nodes, rawEdges } = extractUnityFile("Assets/Bed_1.prefab", PREFAB, "prefab");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.ok(byId.get("Assets/Bed_1.prefab"), "file node");
  const go = byId.get("Assets/Bed_1.prefab#Bed_1");
  assert.ok(go, "GameObject node");
  assert.equal(go.kind, "module");
  assert.equal(go.span, "L3-L5");
  const comp = byId.get("Assets/Bed_1.prefab#Bed_1.CatBed");
  assert.ok(comp, "component node named by its script class");
  assert.equal(comp.span, "L6-L10");
  assert.ok(byId.get("Assets/Bed_1.prefab#Bed_1.MonoBehaviour&201"), "nameless component falls back to fileID");
  const contains = rawEdges.filter((e) => e.relation === "contains");
  assert.ok(
    contains.some((e) => e.source === "Assets/Bed_1.prefab" && e.targetId === "Assets/Bed_1.prefab#Bed_1"),
    "file contains GameObject",
  );
  assert.ok(
    contains.some((e) => e.source === "Assets/Bed_1.prefab#Bed_1" && e.targetId === "Assets/Bed_1.prefab#Bed_1.CatBed"),
    "GameObject contains component",
  );
});

test("empty m_EditorClassIdentifier does not leak onto the next line", () => {
  const doc = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: BedPosition
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}
  m_EditorClassIdentifier:
  occupant: {fileID: 0}
`;
  const { nodes, rawEdges } = extractUnityFile("Assets/Bed.prefab", doc, "prefab");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const comp = byId.get("Assets/Bed.prefab#BedPosition.MonoBehaviour&200");
  assert.ok(comp, "nameless component falls back to fileID (no next-line leak)");
  const refs = rawEdges.filter((e) => e.relation === "references" && "unityGuid" in e);
  assert.ok(refs.length > 0, "m_Script edge emitted");
  for (const e of refs) assert.equal("name" in e ? e.name : undefined, undefined, "edge carries no garbage class name");
});

test("parseMetaGuid reads the asset guid; .meta extracts to a guid signature", () => {
  assert.equal(parseMetaGuid(metaFor(SCRIPT_GUID)), SCRIPT_GUID);
  assert.equal(parseMetaGuid("fileFormatVersion: 2\n"), null);
  const { nodes, rawEdges } = extractUnityFile("Assets/CatBed.cs.meta", metaFor(SCRIPT_GUID), "meta");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].signature, `guid:${SCRIPT_GUID}`);
  assert.deepEqual(rawEdges, []);
});

test("m_Script guids resolve into the C# graph; dangling guids never crash", () => {
  const cs = extractFile("Assets/CatBed.cs", CATBED_CS, "csharp");
  const solo = extractFile("Assets/Solo.cs", SOLO_CS, "csharp");
  const prefab = extractUnityFile("Assets/Bed_1.prefab", PREFAB, "prefab");
  const fbx = extractFbxFile("Assets/BedMesh.fbx", "fbx-text", minimalFbxBytes(["Model::Sofa"]));
  const scene = extractUnityFile("Assets/Room.unity", SCENE, "scene");
  const metas = [SCRIPT_GUID, MESH_GUID, PREFAB_GUID, SOLO_GUID].map((g, i) => {
    const names = ["Assets/CatBed.cs.meta", "Assets/BedMesh.fbx.meta", "Assets/Bed_1.prefab.meta", "Assets/Solo.cs.meta"];
    return extractUnityFile(names[i], metaFor(g), "meta");
  });

  const nodes = [...cs.nodes, ...solo.nodes, ...prefab.nodes, ...fbx.nodes, ...scene.nodes, ...metas.flatMap((m) => m.nodes)];
  const rawEdges = [
    ...cs.rawEdges,
    ...solo.rawEdges,
    ...prefab.rawEdges,
    ...fbx.rawEdges,
    ...scene.rawEdges,
    ...metas.flatMap((m) => m.rawEdges),
  ];
  const edges = resolveEdges(nodes, rawEdges);
  const targets = new Map(edges.map((e) => [`${e.source}→${e.relation}`, e.target] as const));

  // Named script: component → the C# class, certain.
  const scriptEdge = edges.find(
    (e) => e.source === "Assets/Bed_1.prefab#Bed_1.CatBed" && e.relation === "references",
  );
  assert.ok(scriptEdge, "m_Script edge exists");
  assert.equal(scriptEdge.target, "Assets/CatBed.cs#CatBed");
  assert.equal(scriptEdge.confidence, "extracted");

  // Nameless script: the mapped file's single class.
  const soloEdge = edges.find((e) => e.source === "Assets/Bed_1.prefab#Bed_1.MonoBehaviour&202");
  assert.ok(soloEdge, "nameless m_Script edge exists");
  assert.equal(soloEdge.target, "Assets/Solo.cs#Solo");

  // Dangling guid: unresolved target, no throw.
  const dangling = edges.find((e) => e.source === "Assets/Bed_1.prefab#Bed_1.MonoBehaviour&201");
  assert.ok(dangling, "dangling m_Script edge exists");
  assert.equal(dangling.target, `unresolved:${DANGLING_GUID}`);

  // Mesh + prefab linkage: GameObject → FBX file, scene → prefab file.
  assert.equal(
    targets.get("Assets/Bed_1.prefab#Bed_1→references"),
    "Assets/BedMesh.fbx",
    "m_Mesh links prefab GameObject to the FBX file",
  );
  assert.equal(
    targets.get("Assets/Room.unity→references"),
    "Assets/Bed_1.prefab",
    "m_SourcePrefab links scene to prefab",
  );

  // File-level chain links: the prefab file itself references the mesh, so a
  // multi-hop blast radius crosses the prefab boundary (scene→prefab lands on
  // the prefab's file node, prefab→FBX leaves from it).
  assert.ok(
    edges.some((e) => e.source === "Assets/Bed_1.prefab" && e.target === "Assets/BedMesh.fbx"),
    "file-level prefab→FBX edge",
  );
  const fixtureGraph = { meta: { version: 1 as const, nodeCount: 0, edgeCount: 0, languages: [] as string[] }, nodes, edges };
  const fbxFile = nodes.find((n) => n.id === "Assets/BedMesh.fbx")!;
  const blast = impactOf(fixtureGraph, fbxFile, 2);
  assert.ok(blast.some((h) => h.id === "Assets/Bed_1.prefab" && h.depth === 1), "depth-1 reaches the prefab");
  assert.ok(blast.some((h) => h.id === "Assets/Room.unity" && h.depth === 2), "depth-2 reaches the scene");

  // The whole fixture graph holds its structural invariants.
  const problems = checkGraphInvariants({ meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: [] }, nodes, edges });
  assert.deepEqual(problems.problems, []);
});

test("fbxAsciiModels reads Model lines of an ASCII export", () => {
  const src = '; FBX 7.4 project file\nModel: 123, "Model::Chair", "Mesh" {\n}\nModel: 124, "Model::Leg", "Mesh" {\n}\n';
  assert.deepEqual(fbxAsciiModels(src), ["Model::Chair", "Model::Leg"]);
  assert.equal(fbxAsciiModels("no models here\n"), null);
});

test("fbxBinaryModels ports the sandbox node walk (names without decompression)", () => {
  const names = fbxBinaryModels(minimalFbxBytes(["Model::Sofa", "Model::Leg"]));
  assert.deepEqual(names, ["Model::Sofa", "Model::Leg"]);
  assert.equal(fbxBinaryModels(new TextEncoder().encode("not an fbx")), null);
  assert.equal(fbxBinaryModels(new Uint8Array([1, 2, 3])), null); // truncated, not fatal
});

test("extractFbxFile emits one node per model plus the file node", () => {
  const { nodes, rawEdges } = extractFbxFile("Assets/BedMesh.fbx", "fbx-text", minimalFbxBytes(["Model::Sofa"]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("Assets/BedMesh.fbx")?.kind, "file");
  const model = byId.get("Assets/BedMesh.fbx#Sofa");
  assert.ok(model, "model node stripped of its Model:: prefix");
  assert.equal(model.signature, "Model Model::Sofa");
  assert.ok(rawEdges.some((e) => e.source === "Assets/BedMesh.fbx" && e.targetId === "Assets/BedMesh.fbx#Sofa"));
});

test("full build: callers finds the prefab using the script; check is green", async () => {
  const root = tmpRepo("graft-unity-");
  const write = (rel: string, content: string | Uint8Array) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write("Assets/CatBed.cs", CATBED_CS);
  write("Assets/CatBed.cs.meta", metaFor(SCRIPT_GUID));
  write("Assets/Bed_1.prefab", PREFAB);
  write("Assets/Bed_1.prefab.meta", metaFor(PREFAB_GUID));
  write("Assets/Room.unity", SCENE);
  write("Assets/BedMesh.fbx", minimalFbxBytes(["Model::Sofa"]));
  write("Assets/BedMesh.fbx.meta", metaFor(MESH_GUID));

  const built = await buildGraph(root, { reuse: false });
  assert.ok(built.nodes > 0, "build indexed nodes");
  assert.ok(built.languages.includes("unity"), `unity in banner [${built.languages}]`);

  const graph = readGraph(wiringPath(join(root, "graft")))!;
  const cls = graph.nodes.find((n) => n.id === "Assets/CatBed.cs#CatBed");
  assert.ok(cls, "C# class indexed");
  const hits = callersOf(graph, cls);
  assert.ok(
    hits.some((h) => h.id === "Assets/Bed_1.prefab#Bed_1.CatBed" && h.relation === "references"),
    `prefab component calls CatBed (got ${JSON.stringify(hits.map((h) => h.id))})`,
  );
  const hit = hits.find((h) => h.id === "Assets/Bed_1.prefab#Bed_1.CatBed")!;
  assert.ok(hit.node && hit.node.path === "Assets/Bed_1.prefab", "hit carries file:line");

  const check = await checkGraph(root);
  assert.equal(check.ok, true, `check green after build (${JSON.stringify(check)})`);

  // Cards strip only the last extension: `CatBed.cs` → `CatBed.md`, its `.meta`
  // identity file → `CatBed.cs.md` — distinct cards, no clobbering.
  assert.ok(existsSync(join(root, "graft", "Assets", "CatBed.md")), "source card");
  assert.ok(existsSync(join(root, "graft", "Assets", "CatBed.cs.md")), ".meta identity card");
});

/** Minimal valid binary FBX (32-bit offsets): one `Objects` root holding one
 * `Model` record per name. Hand-built so the reader test needs no fixture file. */
export function minimalFbxBytes(models: string[]): Uint8Array {
  const out: number[] = [];
  const ascii = (s: string) => {
    for (const c of s) out.push(c.charCodeAt(0));
  };
  const u8 = (v: number) => out.push(v & 0xff);
  const u32 = (v: number) => {
    out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const u64 = (v: number) => {
    u32(v >>> 0);
    u32(Math.floor(v / 0x100000000));
  };
  const patchU32 = (at: number, v: number) => {
    out[at] = v & 0xff;
    out[at + 1] = (v >>> 8) & 0xff;
    out[at + 2] = (v >>> 16) & 0xff;
    out[at + 3] = (v >>> 24) & 0xff;
  };
  ascii("Kaydara FBX Binary  ");
  u8(0x00);
  u8(0x1a);
  u8(0x00);
  u32(7400);
  const nullRecord = () => {
    u32(0);
    u32(0);
    u32(0);
    u8(0);
  };

  const objectsEnd = out.length;
  u32(0); // patched below
  u32(0);
  u32(0);
  u8(7);
  ascii("Objects");
  for (const name of models) {
    const endAt = out.length;
    u32(0); // patched
    u32(3); // id, name, type
    const plenAt = out.length;
    u32(0); // patched
    const propsStart = out.length;
    u8(5);
    ascii("Model");
    u8("L".charCodeAt(0));
    u64(12345);
    const raw = `${name}\0\x01`;
    u8("S".charCodeAt(0));
    u32(raw.length);
    ascii(raw);
    u8("S".charCodeAt(0));
    u32(4);
    ascii("Mesh");
    patchU32(plenAt, out.length - propsStart);
    patchU32(endAt, out.length);
  }
  nullRecord();
  patchU32(objectsEnd, out.length);
  nullRecord();
  return new Uint8Array(out);
}
