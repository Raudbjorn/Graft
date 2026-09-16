# Arch package and local MCP daemon

Graft's MCP server uses **Streamable HTTP with SSE notifications**. Stdio and
legacy `/sse` transports are no longer supported. CLI graph commands still work
without a daemon or API key.

## Install

```sh
cd packaging/arch
makepkg -si
graft-mcp-setup
set -a
source "$(node -p 'require("node:os").userInfo().homedir')/.config/graft/mcp.env"
set +a
```

`graft-git` builds this fork's default branch. To test an unpublished branch,
set `GRAFT_ARCH_SOURCE=/absolute/path/to/local/git/repository#branch=branch-name`.
The Git source must contain committed changes. Package installation writes only
system files; `graft-mcp-setup` explicitly creates a private user token file and
enables the user service. It never enables lingering or a root service.

Start clients from a shell with `GRAFT_MCP_TOKEN` exported. Existing running
clients need to restart to inherit it. Do not commit the token. `graft init`
writes HTTP registrations; it no longer spawns MCP processes. For existing
installations, rerun the same `graft init` host selection after service setup.

Claude Code `.mcp.json`:

```json
{"mcpServers":{"graft":{"type":"http","url":"http://127.0.0.1:8421/mcp","headers":{"Authorization":"Bearer ${GRAFT_MCP_TOKEN}"}}}}
```

Codex uses `url` and `bearer_token_env_var = "GRAFT_MCP_TOKEN"`. OpenCode uses
`type: "remote"`, `oauth: false`, and `Bearer {env:GRAFT_MCP_TOKEN}` in headers.
Cursor uses `${env:GRAFT_MCP_TOKEN}`. Gemini uses `httpUrl`. Kiro and Droid use
URL/header configurations with `${GRAFT_MCP_TOKEN}` expansion. [Kiro](https://kiro.dev/docs/mcp/configuration/) requires approval of that environment variable; [Droid](https://docs.factory.ai/harness/mcp) reads it from the launching shell. Muse, Grok and Antigravity registration is skipped
with an explanation until authenticated Streamable HTTP support is verified;
use the Graft CLI with those hosts.

## Tools

Every call requires an absolute `project_root`. Optional `context_dir` selects
an absolute graph output directory strictly inside `project_root`. Output trees containing symlinks are rejected. Workspace conversion removes known graph cards and wiring, preserving unrelated files and cache entries. Example:

```json
{"name":"graft_build","arguments":{"project_root":"/home/me/project"}}
```

`graft_build` creates the structural graph and markdown cards and returns paths
and counts. `graft_repo_map` summarizes an existing graph. Queries refresh an
existing graph automatically; they do not silently index a new repository.
Workspace children retain their own graphs. Builds are local and need no API key.

Connected sessions become interested in a repository when they call a tool for
it. Completed and failed daemon builds/refreshes generate MCP logging messages
(`graft.build`) over SSE. Request progress is sent when a client supplies a
progress token. Display depends on the client; this does not guarantee a desktop
notification or a new agent turn. External CLI builds are not watched, and
notifications are not replayed after disconnect/restart.

## Operations

```sh
systemctl --user status graft-mcp
journalctl --user -u graft-mcp
systemctl --user restart graft-mcp
systemctl --user disable --now graft-mcp
```

The daemon listens only on `127.0.0.1:8421`. To change the port, use a systemd
override (`systemctl --user edit graft-mcp`), clearing the old command first:

```ini
[Service]
ExecStart=
Environment=GRAFT_MCP_URL=http://127.0.0.1:9000/mcp
ExecStart=/usr/bin/graft mcp
```

Then set `GRAFT_MCP_URL=http://127.0.0.1:9000/mcp` before explicitly
regenerating host configurations. Only HTTP loopback URLs are accepted; localhost is normalized to IPv4 127.0.0.1. `--port`, if supplied, must match that URL. The token is required on every HTTP request.
Authentication failures log a reason (missing/empty token, unexpanded variable, invalid scheme or mismatch), never the token. All authenticated clients have the filesystem access of the service user. The service and setup use the account home’s `.config/graft/mcp.env`, independent of `XDG_CONFIG_HOME`.

At most four reusable worker processes run tools. Calls for one repository/output
are serialized, identical in-flight builds are shared, and excess work queues.
Workers exit after 60 seconds idle and are replaced when switching repositories,
so native grammars and language packs stay isolated. Jobs time out after two minutes
without progress (or in the queue), configurable with `GRAFT_MCP_JOB_TIMEOUT_MS`.
Build progress renews the timer; lock waits report progress and have a separate
5½-minute limit. Unverifiable legacy/foreign lock owners can be reclaimed after five minutes; Linux owners are checked by host, boot, PID namespace and process start identity. Extraction checkpoints after 1,024 files and then at doubling intervals let retries reuse
completed files. A killed refresh retries the query against the last saved graph
with a stale-answer warning. Graph caches retain up to 16 entries/128 MiB per cache,
plus one oversized active graph when needed; these are serialized sizes, not RSS limits. Four occupied workers can delay another
repository's query; the HTTP listener stays responsive. Sessions expire after
30 minutes without requests, active work, or an open SSE stream. Reconnect to start a new session.

Removing stdio is a breaking change: update old `command`/`args` registrations.
Stopping the service leaves CLI tools usable and graph files intact. To roll
back to an older stdio release, reinstall it and rerun that release's host setup.

References: [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server),
[Claude Code](https://code.claude.com/docs/en/mcp),
[Arch VCS packaging](https://wiki.archlinux.org/title/VCS_package_guidelines).

### Upgrading from stdio or installing through npm

Upkeep refreshes hooks and skills, but does not opt clients into HTTP or replace
existing MCP registrations. Token-less init also preserves existing registrations. Successful explicit HTTP registration replaces a selected host’s old entry; unsupported hosts retain their entries with a skipped-row explanation. Start `graft mcp` with `GRAFT_MCP_TOKEN` set, export the same token
in the environment that starts your MCP client, then run `graft init` explicitly.
Registration is skipped if the token is absent. For Arch, `graft-mcp-setup`
creates the token and starts the user service; follow its environment instructions.
A token in the service environment does not set it in an already-running editor.
The source checkout does not ship an enabled MCP registration.
