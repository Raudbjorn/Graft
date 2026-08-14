/**
 * Graft wiring graph에서 결합도가 높은 심볼을 찾는 학습 예제다.
 * 실행: npx tsx guide/examples/inspect-graph.ts PATH_TO_WIRING_JSON
 */
import { readFile } from "node:fs/promises";

interface GraphNode {
  id: string;
  name: string;
  kind: string;
  path: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface WiringGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function isWiringGraph(value: unknown): value is WiringGraph {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WiringGraph>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

const graphPath = process.argv[2];
if (!graphPath) {
  console.error("Usage: npx tsx guide/examples/inspect-graph.ts WIRING_JSON");
  process.exit(2);
}

const parsed: unknown = JSON.parse(await readFile(graphPath, "utf8"));
if (!isWiringGraph(parsed)) throw new Error("지원하지 않는 wiring graph 형식입니다.");

// 들어오는 edge 수는 다른 코드가 이 심볼에 얼마나 의존하는지 보는 간단한 지표다.
const incoming = new Map<string, number>();
for (const edge of parsed.edges) {
  incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
}

const hubs = parsed.nodes
  .filter((node) => node.kind !== "file")
  .map((node) => ({ node, inDegree: incoming.get(node.id) ?? 0 }))
  .sort((a, b) => b.inDegree - a.inDegree || a.node.id.localeCompare(b.node.id))
  .slice(0, 10);

console.log(`nodes=${parsed.nodes.length}, edges=${parsed.edges.length}`);
for (const { node, inDegree } of hubs) {
  console.log(`${inDegree.toString().padStart(3)} ← ${node.name} (${node.path})`);
}
