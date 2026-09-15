import { maybeFlushInBackground } from '../telemetry/flush.js';
import { createServer, type IncomingMessage } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { canonicalToolName } from './tool-names.js';
import { ToolPool } from './pool.js';
import type { BuildEvent } from './build.js';

import { mcpPort, DEFAULT_MCP_PORT, MCP_BODY_LIMIT_BYTES, MCP_MAX_SESSIONS, MCP_MAX_ROOTS_PER_SESSION, MCP_WORKERS, MCP_SESSION_IDLE_MS, MCP_SESSION_SWEEP_MS, MCP_REQUEST_TIMEOUT_MS } from './config.js';
export { DEFAULT_MCP_PORT } from './config.js';

function absoluteDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute directory path`);
  const path = realpathSync(value);
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory`);
  return path;
}
function outputDirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('context_dir must be an absolute directory path');
  try { return absoluteDirectory(value, 'context_dir'); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(value);
    if (parent === value) throw error;
    return join(outputDirectory(parent)!, value.slice(parent.length));
  }
}
class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MCP_BODY_LIMIT_BYTES) throw new BodyTooLargeError('Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startMcpServer(opts: { port?: number; token: string; version?: string; workers?: number; idleMs?: number; sessionIdleMs?: number; sessionSweepMs?: number; maxSessions?: number }) {
  if (!opts.token || /\s/.test(opts.token)) throw new Error('Set GRAFT_MCP_TOKEN to a nonempty bearer token without whitespace');
  maybeFlushInBackground();
  const pool = new ToolPool(opts.workers ?? MCP_WORKERS, opts.idleMs);
  type Session = { server: Server; transport: StreamableHTTPServerTransport; roots: Set<string>; touched: number; active: number; streams: number };
  const sessions = new Map<string, Session>();
  const closeSession = async (session: Session) => {
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    session.roots.clear();
    try { await session.server.close(); }
    catch (error) {
      console.error('MCP session close failed:', error);
      try { await session.transport.close(); }
      catch (error) { console.error('MCP transport close failed:', error); }
    }
  };
  let pendingSessions = 0;
  let port = 0;
  let shuttingDown = false;
  const authorization = Buffer.from(`Bearer ${opts.token}`);
  const schemas = TOOLS.map(tool => {
    const schema = tool.inputSchema as { properties?: object; required?: string[] };
    return { ...tool, inputSchema: { type: 'object' as const, properties: { ...schema.properties,
      project_root: { type: 'string', description: 'Absolute local repository directory' },
      context_dir: { type: 'string', description: 'Optional absolute graph output directory' } },
      required: [...(schema.required ?? []), 'project_root'] } };
  });
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(schemas.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
  const http = createServer(async (req, res) => {
    const reject = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(message); };
    if (shuttingDown) return reject(503, 'MCP server is shutting down');
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) return reject(403, 'Invalid Host');
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return reject(403, 'Invalid Origin');
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== authorization.length || !timingSafeEqual(given, authorization)) return reject(401, 'Unauthorized');
    if (req.url !== '/mcp') return reject(404, 'Not found');
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { res.setHeader('Allow', 'GET, POST, DELETE'); return reject(405, 'Method not allowed'); }
    if (Number(req.headers['content-length'] ?? 0) > MCP_BODY_LIMIT_BYTES) return reject(413, 'Request body exceeds 1 MiB');
    let reserved = false;
    let provisional: Session | undefined;
    try {
      let body: unknown;
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reject(415, 'Expected application/json');
        try { body = await readBody(req); } catch (error) { return reject(error instanceof BodyTooLargeError ? 413 : 400, 'Invalid request body'); }
      }
      const id = req.headers['mcp-session-id'];
      let session = typeof id === 'string' ? sessions.get(id) : undefined;
      if (id && !session) return reject(404, 'Unknown session');
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) return reject(400, 'Initialize a session first');
        if (sessions.size + pendingSessions >= (opts.maxSessions ?? MCP_MAX_SESSIONS)) return reject(503, 'Too many sessions');
        pendingSessions++;
        reserved = true;
        const server = new Server({ name: 'graft', version: opts.version ?? '0' },
          { capabilities: { tools: {}, logging: {} }, instructions: mcpInstructions() });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => { sessions.set(id, session!); } });
        session = { server, transport, roots: new Set(), touched: Date.now(), active: 0, streams: 0 };
        provisional = session;
        const current = session;
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schemas }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          try {
            const args = { ...request.params.arguments };
            const name = canonicalToolName(request.params.name);
            if (name === 'graft_trace_calls' && args.symbol === undefined && args.file !== undefined) args.symbol = args.file;
            const schema = schemas.find(tool => tool.name === name);
            if (!schema) throw new Error(`Unknown tool: ${name}`);
            const validation = validators.get(name)!(args);
            if (!validation.valid) throw new Error(validation.errorMessage);
            const root = absoluteDirectory(args.project_root, 'project_root');
            const contextDir = outputDirectory(args.context_dir);
            if (current.roots.size >= MCP_MAX_ROOTS_PER_SESSION && !current.roots.has(root)) throw new Error('Too many repository subscriptions in this session');
            current.roots.add(root);
            current.active++;
            let progress = 0;
            const progressToken = request.params._meta?.progressToken;
            const result = await pool.run(root, name, args, contextDir, (event: BuildEvent) => {
              if (progressToken !== undefined && event.progress !== undefined)
                void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress, message: `${event.project_root}: ${event.progress}/${event.total ?? '?'}` } }).catch(error => console.error('MCP progress notification failed:', error));
              if (event.status !== 'completed' && event.status !== 'failed') return;
              for (const subscriber of sessions.values()) {
                if (subscriber.roots.has(root) || subscriber.roots.has(event.project_root))
                  void subscriber.server.sendLoggingMessage({ level: event.status === 'failed' ? 'error' : 'info', logger: 'graft.build', data: event }, subscriber.transport.sessionId).catch(error => console.error('MCP build notification failed:', error));
              }
            }).finally(() => { current.active--; current.touched = Date.now(); });
            return { content: [{ type: 'text' as const, text: result.text }, ...(result.notices ?? []).map(text => ({ type: 'text' as const, text }))], isError: result.isError };
          } catch (error) {
            return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
        });
        server.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); current.roots.clear(); };
        await server.connect(transport);
      }
      session.touched = Date.now();
      if (req.method === 'GET') {
        const current = session;
        current.streams++;
        res.once('close', () => { current.streams--; current.touched = Date.now(); });
      }
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('MCP request failed:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) reject(500, 'Internal server error'); else res.end();
    } finally {
      if (reserved) pendingSessions--;
      if (provisional && !provisional.transport.sessionId) await closeSession(provisional);
    }
  });
  http.requestTimeout = MCP_REQUEST_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(opts.port ?? mcpPort(), '127.0.0.1', resolve); });
  port = (http.address() as { port: number }).port;
  const expiry = setInterval(() => {
    for (const session of sessions.values()) if (!session.active && !session.streams && Date.now() - session.touched > (opts.sessionIdleMs ?? MCP_SESSION_IDLE_MS)) void closeSession(session);
  }, opts.sessionSweepMs ?? MCP_SESSION_SWEEP_MS);
  expiry.unref();
  let closing: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${port}/mcp`,
    close: () => closing ??= (async () => {
      shuttingDown = true;
      clearInterval(expiry);
      const stopped = new Promise<void>(resolve => http.close(() => resolve()));
      try {
        await Promise.allSettled([...sessions.values()].map(closeSession));
      } finally {
        http.closeAllConnections();
        await pool.close();
        await stopped;
      }
    })(),
  };
}
