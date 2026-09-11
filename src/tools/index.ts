/**
 * `@nanonets/graft/tools` — the tool API as a public entry point.
 *
 * The implementation stays where it is (`src/mcp/tools.ts`): six tool
 * definitions and one never-throwing `callTool` over the engine. Until this
 * subpath existed the only way to reach them was through the MCP protocol shell
 * beside them, so any host integrating Graft in-process — DSH's `ctx.tools`, an
 * editor extension, a test harness — either spoke JSON-RPC to a child process
 * or imported an internal build path nothing promised to keep stable.
 *
 * This module is that promise, and nothing else: no logic, no MCP, no new
 * behaviour. A new tool still lands in `src/mcp/tools.ts` and appears here for
 * free.
 */
export { TOOLS, callTool, type ToolDef } from '../mcp/tools.js';
export { canonicalToolName } from '../mcp/tool-names.js';
