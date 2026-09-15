/** Shared daemon defaults. Durations are milliseconds, sizes are bytes. */
export const DEFAULT_MCP_PORT = 8421;
export const DEFAULT_MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`;
export const MCP_BODY_LIMIT_BYTES = 1_048_576;
export const MCP_MAX_SESSIONS = 256;
export const MCP_MAX_ROOTS_PER_SESSION = 256;
export const MCP_MAX_QUEUED_JOBS = 256;
export const MCP_MAX_BUILD_WAITERS = 256;
export const MCP_WORKERS = 4;
export const MCP_WORKER_IDLE_MS = 60_000;
export const MCP_JOB_TIMEOUT_MS = 120_000;
export const MCP_SHUTDOWN_GRACE_MS = 5000;
export const MCP_SESSION_IDLE_MS = 30 * 60_000;
export const MCP_SESSION_SWEEP_MS = 60_000;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_PROGRESS_INTERVAL_MS = 100;
export const MCP_BUILD_LOCK_WAIT_MS = 30_000;
export const MCP_BUILD_LOCK_POLL_MS = 50;

export function mcpUrl(value = process.env.GRAFT_MCP_URL || DEFAULT_MCP_URL): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash)
    throw new Error('GRAFT_MCP_URL must be an HTTP loopback URL ending in /mcp, without credentials, query or fragment');
  return url.href;
}
