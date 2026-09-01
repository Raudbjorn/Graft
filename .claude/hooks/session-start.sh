#!/bin/bash
# Prepares a Claude Code on the web session: project dependencies, the graft
# CLI, and a freshly built code graph. Safe to re-run; skipped on local machines.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Project dependencies, so `npm test` and `npm run build` work in the session.
npm install --no-audit --no-fund

# The graft CLI. The container starts bare, so it is reinstalled every session;
# `.mcp.json` and the hooks below both shell out to this binary.
if ! command -v graft >/dev/null 2>&1; then
  npm install -g --no-audit --no-fund @nanonets/graft
fi

# The graph itself (graft/) is git-ignored, so it is rebuilt from source here.
graft build
