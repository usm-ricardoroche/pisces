# Pisces — Fork Plan

Pisces is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) targeting
first-class headless/server use, specifically as the execution harness for
[lobster-party](https://github.com/usm-ricardoroche/lobster-party).

This document captures what was learned from hands-on testing of oh-my-pi's
headless behavior and defines the changes needed for a clean lobster-party integration.

---

## Context: lobster-party integration model

`lobster-loop` (the lobster-party gRPC worker) currently drives `opencode` as
a subprocess per turn:

```
TurnRequest (gRPC)
  └─ sandbox spawn: opencode run --model=... --agent=... --format=json <prompt>
       └─ stdout: JSONL event stream
            └─ parse → TurnResponse
                  └─ async: session ID extracted → stored for next turn's --session=<id>
```

Pisces replaces `opencode` in this pipeline. The gRPC surface, clawplexer, auth,
QMD indexing, and conversation store are all **unchanged**. Only the subprocess
invocation and output parsing change.

Target invocation:

```bash
omp -p --mode json \
    --model=<model> \
    [--resume <session-id>] \
    --no-title \
    <prompt>
```

---

## Confirmed test results (tested 2026-04-02)

| Behavior | Result | Notes |
|---|---|---|
| `-p` non-interactive mode | ✅ works | exits 0/1 correctly |
| `--mode json` (space syntax) | ✅ works | emits JSONL event stream |
| `--mode=json` (equals syntax) | ❌ silently text mode | flag parsing bug |
| Session ID in first JSON line | ✅ `.id` field | `head -1 \| jq .id` |
| `--resume <full-id>` | ✅ works | full 16-char hex ID required |
| `--resume <prefix>` | ❌ wrong session | prefix matching unreliable |
| `--continue` | ✅ works | latest finalized session only |
| Chained resume (T1→T2→T3) | ✅ works | each resume creates new session |
| `--session-dir` | ❌ no effect | flag doesn't redirect sessions |
| `PI_CODING_AGENT_DIR` isolation | ✅ works | but needs config.yml in dir |
| Session file after `-p` exit | ❌ stays `.tmp` | **primary blocker** |
| Resume from `.tmp` file | ❌ not indexed | only finalized `.jsonl` found |

### The session finalization bug (critical)

When `omp -p` exits, the session JSONL is left as a `.tmp` file
(`.<timestamp>_<id>.jsonl.<suffix>.tmp`). The atomic rename to the final
`.jsonl` path is an async operation that doesn't complete before process exit.

The file content is **complete and correct** — a manual rename makes it
resumable. But `--resume` only searches for finalized `.jsonl` files.

This means the current oh-my-pi cannot support the lobster-loop session
resumption model without modification.

### The AWS Bedrock auto-discovery issue

When `PI_CODING_AGENT_DIR` points to a directory with no `config.yml`,
omp auto-discovers providers from the environment. With `AWS_BEARER_TOKEN_BEDROCK`
+ `AWS_PROFILE` set, it picks Bedrock as default and uses a non-inference-profile
model ID that's unsupported. This is **not a pisces bug** — in the lobster sandbox
a proper `config.yml` is mounted. But pisces should document the required config
and fail fast with a clear error if no model config is found.

---

## Changes to implement

### P0 — Required for lobster-party integration

#### 1. Fix session persistence in `-p` print mode

**File:** `packages/coding-agent/src/modes/print-mode.ts`

After the final turn completes and before `session.dispose()`, ensure the
session storage is flushed and the `.tmp` file is renamed to its final `.jsonl`
path. The session `id` must be in the final path so `--resume <id>` can find it.

```typescript
// Before dispose():
await session.storage.flush()
await session.storage.fsync()
await session.storage.finalize()  // rename .tmp → .jsonl
```

The `SessionStorageWriter` already has `flush()` and `fsync()`. Add a
`finalize()` method (or expose the rename directly) so print mode can call it
synchronously before exit.

**Why this is P0:** Without it, every `-p` turn creates an orphaned `.tmp` file,
`--resume` always fails, and lobster-loop loses conversation context across turns.

#### 2. Emit session file path in `agent_end` event

**File:** `packages/coding-agent/src/modes/print-mode.ts` (JSON mode event emission)

Add the finalized session file path to the `agent_end` JSON event:

```json
{
  "type": "agent_end",
  "sessionId": "14ab14fe4459c323",
  "sessionFile": "/path/to/sessions/<cwd>/<timestamp>_<id>.jsonl",
  "messages": [...]
}
```

This lets lobster-loop extract the session ID without scanning the filesystem
or relying on the first-line parse. It's the canonical handoff point.

#### 3. Fix `--mode=json` flag parsing

**File:** `packages/coding-agent/src/cli/args.ts` (or wherever `--mode` is parsed)

The `=`-style flag (`--mode=json`) silently falls through to text mode.
`--mode json` (space) works correctly. Normalize both forms.

#### 4. Port `messageUser` and `memorySearch` tools to pisces extension API

**File:** `packages/coding-agent/` — new file, e.g. `src/lobster/tools.ts`

The current `agent.ts` in lobster-party's `config/opencode-runtime/` uses
`@opencode-ai/plugin`. Pisces uses `ExtensionAPI.registerTool()` with TypeBox
schemas. Port both tools:

- `messageUser` — calls `majordomo-do --socket ... --run-channel-key ... --message-user-text`
- `memorySearch` — calls `majordomo-do --socket ... --command-id qmd.query`

The Unix socket path, run-channel-key mechanism, and retry logic are identical.
Only the tool registration API differs.

These tools should live in pisces as a built-in lobster extension, loaded when
`PISCES_LOBSTER_MODE=1` is set (or via a dedicated `--lobster` flag).

#### 5. Update `grpc.rs` output parsing in lobster-loop

**File:** `lobster-party/cmd/lobster-loop/src/grpc.rs`

Replace opencode-specific parsing with pisces event schema:

| opencode | pisces |
|---|---|
| `parse_opencode_json_output` | `parse_pisces_json_output` |
| `extract_opencode_session_id` | read `.id` from first line |
| `--format=json` | `--mode json` |
| `--session=<id>` | `--resume <id>` |
| `/usr/local/bin/opencode` | `/usr/local/bin/omp` (or `pisces`) |

Pisces `turn_end` event shape (confirmed):
```json
{
  "type": "turn_end",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "thinking", "thinking": "..."},
      {"type": "text", "text": "final response"}
    ]
  }
}
```

Response text: walk `turn_end.message.content` for `type === "text"` items.
Thinking text: walk for `type === "thinking"` items.
Session ID: `JSON.parse(firstLine).id`.

#### 6. `--session-dir` flag — make it actually work

**File:** `packages/coding-agent/src/cli/args.ts` + session storage init

Make `--session-dir <path>` redirect where sessions are stored for this run,
overriding the `<PI_CODING_AGENT_DIR>/sessions/<cwd>/` default.

This lets lobster-loop point each claw at its own session directory without
needing full `PI_CODING_AGENT_DIR` isolation. Simpler sandbox config.

---

### P1 — Quality of life / lobster-party ergonomics

#### 7. `--no-provider-discovery` flag

When set, skip auto-discovery of ambient providers (Bedrock, Ollama, LM Studio,
GitHub Copilot). Only use explicitly configured providers from `config.yml` or
`--model` flags. Prevents the Bedrock-as-default footgun when running in
environments with AWS credentials present.

#### 8. Structured exit on error

When `-p` exits with code 1, write a JSON error line to stdout so the harness
can distinguish error types:

```json
{"type": "error", "code": "TURN_FAILED", "message": "..."}
```

Currently only a plain text message goes to stderr.

#### 9. `--agent <name>` flag

oh-my-pi has the concept of bundled agents (explore, plan, reviewer, etc.).
Add a `--agent` flag to `omp -p` that selects which agent runs, matching
opencode's `--agent=<name>` interface. This lets lobster-loop select the
`lobster-runtime` agent persona by name, not just by system prompt content.

#### 10. Rename binary to `pisces` (optional / cosmetic)

If we want a clean break: rename the `omp` CLI binary to `pisces`. Affects
`package.json` bin entry and sandbox rootfs install path. Keep `omp` as an alias.
Not strictly required — lobster-loop can invoke either name.

---

### P2 — Improvements over opencode (exploit pisces capabilities)

These aren't needed for basic integration but justify the fork over staying with opencode.

#### 11. LSP integration in sandbox

Configure `--lsp` with appropriate language servers in the sandbox rootfs.
Gives the lobster-runtime agent inline type errors, go-to-definition, and
refactoring tools across Kotlin/TypeScript/Python — without custom tools.

#### 12. Subagent support in lobster turns

Expose the six bundled agents (explore, plan, designer, reviewer, task, quick_task)
via the `--agent` flag (from P1). Lobster-loop can dispatch a `plan` turn or
`reviewer` turn by just changing one flag, reusing the same session.

#### 13. TTSR rules for lobster runtime

Port the lobster-party `BASE_PROMPT.rendered.txt` content to TTSR rules.
TTSR rules only inject into context when triggered by pattern match, consuming
zero tokens otherwise. This reduces per-turn cost on simple turns that don't
need the full base prompt.

#### 14. Session branching for debugging

The pisces session tree (every `-p` run creates a branch from `--resume`) is
naturally audit-log friendly. Lobster-party can expose the session tree via
`admin_read` for debugging agent behavior across a conversation thread.

---

## Feature opt-in model

A core design goal: **lobster-party behavior is identical to the current opencode
integration by default.** All additional pisces capabilities are opt-in via config
file or env vars. This means:

- Swapping the binary in the sandbox is safe — nothing changes unless explicitly enabled.
- Features can be enabled per-claw, per-worktree, or globally via `pisces.json`.
- The fallback position is always "works exactly like opencode did."

### Default-off features and how to enable them

| Feature | Default | Enable via |
|---|---|---|
| LSP tools | off (`--no-lsp` in sandbox invocation) | `PISCES_LSP=1` env or `lsp.enabled: true` in `pisces.json` |
| IPython kernel | off (`--no-pty` equivalent) | `PISCES_PYTHON=1` env or `python.enabled: true` in `pisces.json` |
| Browser/Puppeteer | off | `PISCES_BROWSER=1` env or `browser.enabled: true` in `pisces.json` |
| Subagents | off | set via `--agent <name>` in the lobster-loop `SandboxRequest.args` |
| TTSR rules | off | place `.md` files with `ttsr_trigger:` frontmatter in `pisces.json` `instructions` |
| Memory system | off | `PISCES_MEMORY=1` env or `memories.enabled: true` in `pisces.json` |
| Web search | off | `PISCES_WEB=1` env or `web.enabled: true` in `pisces.json` |
| Lobster extension | off | `PISCES_LOBSTER_MODE=1` env (messageUser + memorySearch tools) |
| Provider auto-discovery | **on** in omp, **off** in pisces default | `PISCES_PROVIDER_DISCOVERY=1` to re-enable |

### `pisces.json` config file

pisces inherits `opencode.json` schema but extends it:

```json
{
  "$schema": "https://pisces.dev/config.json",
  "instructions": ["..."],
  "lsp": { "enabled": false },
  "python": { "enabled": false },
  "browser": { "enabled": false },
  "memories": { "enabled": false },
  "providerDiscovery": { "enabled": false }
}
```

The lobster sandbox mounts this as a read-only config at `PISCES_CONFIG_DIR`,
exactly as `opencode.json` is today. Enabling a feature is a one-line change
in `config/opencode-runtime/pisces.json` and a redeploy.

### env var vs config file

- **Env vars** (`PISCES_LSP=1` etc.) take precedence over config file. Use them
  for per-turn overrides from lobster-loop's `SandboxRequest.env`.
- **`pisces.json`** sets the per-claw baseline. Mount different configs for
  different claw roles (e.g. a `reviewer` claw with LSP enabled, a `chat` claw
  with everything off).

### Behaviour parity guarantee

When lobster-loop invokes pisces with the same flags used for opencode today
(`-p --mode json --no-lsp --no-title`), the output schema, exit codes, and
session semantics are identical. The only difference visible to lobster-loop
is:

1. Binary name: `omp` (or `pisces`) instead of `opencode`
2. Flag: `--mode json` instead of `--format=json`
3. Flag: `--resume <id>` instead of `--session=<id>`

Everything else — turn output parsing, session ID extraction, summarization
model invocation — is structurally the same.

---

## Integration architecture (final state)

```
TurnRequest (gRPC)
  └─ lobster-loop (Rust)
       ├─ lookup: thread_id → latest_session_id
       └─ sandbox spawn: omp -p --mode json
                           --model=<model>
                           [--resume <session-id>]
                           --no-title
                           --no-provider-discovery   ← P1.7
                           --agent lobster-runtime    ← P1.9
                           <prompt>
            └─ stdout JSONL:
                 line 1: {"type":"session","id":"<new-session-id>", ...}
                 ...
                 turn_end: {"type":"turn_end","message":{...}}
                 agent_end: {"type":"agent_end","sessionFile":"<path>", ...}  ← P0.2
            └─ grpc.rs:
                 - extract new session ID from line 1
                 - extract response+thinking from turn_end
                 - store new session ID → thread_id map
                 - async: summarize → write TurnRecord
```

The session chain across turns:
```
Turn 1: --resume (none)    → new session A  → store A for thread
Turn 2: --resume A         → new session B  → store B for thread
Turn 3: --resume B         → new session C  → store C for thread
```

Each session is a branch from the previous, forming a linked chain. The full
conversation history is reconstructable by following the chain.

---

## Shoal-CLI integration

Shoal is a terminal-first orchestration tool for parallel AI coding agents
(Fish + tmux + git worktrees + MCP pooling). It sits at the **developer
experience layer** — separate from lobster-party's server-side gRPC stack.
The two systems complement each other:

- **lobster-party** = API-first server harness (gRPC, sandboxed claws, cloud-hosted)
- **shoal** = terminal orchestration layer (tmux, worktrees, local developer sessions)

Pisces must be a first-class citizen in both.

### What shoal needs: a pisces tool profile

Shoal uses TOML tool profiles (`~/.config/shoal/tools/<name>.toml`) to define
how to launch and monitor each AI agent. Pi (`pi.toml`) and opencode
(`opencode.toml`) are already shipped. Pisces needs its own profile.

**New file: `examples/config/tools/pisces.toml`** (shoal repo)

```toml
# Shoal — Pisces coding agent tool definition
# https://github.com/usm-ricardoroche/pisces
# Install: npm install -g pisces (or bun add -g pisces)
# Place in ~/.config/shoal/tools/pisces.toml

[tool]
name = "pisces"
command = "omp"          # or "pisces" once binary renamed
icon = "🐟"

[detection]
# Pisces TUI shares oh-my-pi's rendering; reuse pi patterns with additions
busy_patterns  = ["thinking", "generating", "executing", "reading", "writing", "editing",
                  "searching", "running lsp", "subagent"]
waiting_patterns = ["permission", "confirm", "approve", "y/n", "│ >"]
error_patterns   = ["Error:", "error:", "ERROR", "FAILED", "turn failed"]
idle_patterns    = ["│ >", "\\$"]

[mcp]
# Pisces uses its own plugin/extension system for MCP — not a JSON config file.
# MCP servers are configured via PISCES_MCP_SOCKETS env var (Unix socket list)
# or the [mcp] section in pisces.json. Set socket_env here so Shoal's MCP pool
# can inject the shoal-orchestrator socket directly into the pisces process.
config_cmd  = ""
config_file = "pisces.json"          # project-local pisces config (if present)
socket_env  = "PISCES_MCP_SOCKETS"  # env var pisces reads for additional MCP sockets
```

**Key difference vs pi.toml:** `socket_env = "PISCES_MCP_SOCKETS"` tells shoal
that it can pass shoal's MCP socket pool to pisces via an env var. This is the
hook that enables shared MCP servers between shoal-managed pisces sessions.

### MCP socket injection

Shoal's MCP pool runs shared MCP servers on Unix sockets. When shoal starts a
pisces session, it can inject the socket list:

```bash
PISCES_MCP_SOCKETS=/tmp/shoal-mcp/memory.sock:/tmp/shoal-mcp/filesystem.sock \
  omp --no-title
```

Pisces must read `PISCES_MCP_SOCKETS` (colon-delimited socket paths) and
register each as a stdio MCP client on startup. This gives pisces sessions
access to shoal's pooled memory, filesystem, and `shoal-orchestrator` servers —
with **no per-session MCP process startup cost**.

**Required pisces change (P1):**

In `packages/coding-agent/src/main.ts` (or MCP init path):

```typescript
const extraSockets = (process.env.PISCES_MCP_SOCKETS ?? "").split(":").filter(Boolean)
for (const socket of extraSockets) {
  extension.registerMCPClient({ transport: "unix", socket })
}
```

This is how pisces becomes a shoal MCP pool client. The shoal `shoal-orchestrator`
MCP server (which exposes `list_sessions`, `send_keys`, `create_session` etc.)
becomes available to the pisces agent as a native tool — enabling orchestration
loops without any custom tooling.

### Session template for interactive pisces development

**New file: `examples/config/templates/pisces-dev.toml`** (shoal repo)

```toml
# Shoal — Pisces interactive development template
# Usage: shoal new --template pisces-dev

[template]
name = "pisces-dev"
description = "Pisces agent with terminal pane and MCP orchestration"
extends = "base-dev"
tool = "pisces"
mixins = ["shoal-orchestrator"]  # inject shoal MCP tools

[template.env]
SHOAL_TOOL = "pisces"
# Disable server features not needed in interactive mode
PISCES_LOBSTER_MODE = "0"
PISCES_PROVIDER_DISCOVERY = "1"   # enable in interactive mode (user has credentials)

[[windows]]
name = "editor"
focus = true

[[windows.panes]]
split = "root"
size = "65%"
title = "pisces-agent"
command = "{tool_command}"

[[windows.panes]]
split = "right"
size = "35%"
title = "terminal"
command = "echo 'Terminal — git, tests, omp debug'"

[[windows]]
name = "tools"
cwd = "{work_dir}"

[[windows.panes]]
split = "root"
title = "runner"
command = "echo 'Build/test runner'"
```

### Robo supervisor with pisces backend

The shoal robo supervisor is "just another agent session with shoal CLI access."
Pisces becomes the robo supervisor's agent tool — giving the supervisor access
to shoal orchestration MCP tools natively.

**New file: `examples/config/robo/pisces-robo.toml`** (shoal repo)

```toml
[profile]
name = "pisces-robo"
tool = "pisces"
auto_approve = false

[monitoring]
poll_interval = 10
waiting_timeout = 300

[escalation]
notify = true
auto_respond = false
```

With the `shoal-orchestrator` MCP server available inside the robo pisces
session, the supervisor can call `list_sessions`, `send_keys`, and
`create_session` as first-class MCP tools — no CLI subprocess wrapping needed.

### Status detection tuning

Pisces has a richer TUI than base pi: it shows LSP status indicators, subagent
names, and memory search progress. Shoal's watcher needs patterns for these:

```toml
# Add to pisces.toml [detection]:
busy_patterns = [
  # Standard pi patterns
  "thinking", "generating", "executing", "reading", "writing", "editing",
  # Pisces extensions
  "searching",          # memory/web search in progress
  "running lsp",        # LSP diagnostics run
  "subagent: \\w+",     # spawned subagent name
  "checking",           # TTSR rule pattern match
]
```

### Journal integration

Shoal's `core/journal.py` records session journals (append-only Markdown per
session, MCP-accessible via `append_journal`/`read_journal`). Pisces can write
to its session journal by calling the shoal MCP tool when `shoal-orchestrator`
is in scope — no extra tooling in pisces needed.

The lobster-party `messageUser` tool and shoal journals serve overlapping roles:
- `messageUser` → routes to an active conversation channel in the clawplexer
  WebSocket (real-time user-facing message)
- shoal journal → persistent per-session audit log for the developer

Both should coexist. In interactive shoal sessions (not lobster-party sandboxed
claws), the agent can write to the journal directly via MCP.

### What shoal changes to be pisces-compatible

A summary of concrete work required in the shoal repo:

#### Shoal changes (concrete work items)

1. **Add `examples/config/tools/pisces.toml`** — tool profile with correct
   detection patterns and `socket_env = "PISCES_MCP_SOCKETS"`.

2. **Add `examples/config/templates/pisces-dev.toml`** — interactive dev template
   extending `base-dev`, using pisces tool, injecting `shoal-orchestrator` mixin.

3. **Add `examples/config/robo/pisces-robo.toml`** — robo profile using pisces
   as supervisor agent.

4. **`src/shoal/services/mcp_pool.py`**: Teach shoal's pool startup to set
   `PISCES_MCP_SOCKETS` in the pisces session environment when starting a pisces
   session with MCP servers configured. Currently shoal injects MCP config file
   paths; for pisces it must inject the socket list via env var instead.

   Concretely: when `tool.mcp.socket_env` is set in the tool profile, and the
   session has MCP servers configured, shoal builds the socket list and injects
   it as `{socket_env}=<socket1>:<socket2>:...` in the startup environment.

5. **`src/shoal/services/lifecycle.py`**: When resolving startup command for a
   pisces session, substitute `{pisces_config}` with the path to `pisces.json`
   if present in the worktree root or `~/.config/shoal/`. (Mirrors how
   `config_file = "pisces.json"` in the tool profile is used.)

6. **`src/shoal/core/detection.py`** (or wherever tool patterns are resolved):
   Ensure the extended busy/waiting/idle patterns in `pisces.toml` are validated
   and compiled correctly for the pisces TUI's differential output format
   (same as pi — frame-differential rendering, not full-screen redraws).

7. **`ROADMAP.md`**: The existing `Future Considerations` note about omp integration
   should be updated to reference pisces and this plan.

#### Pisces changes required for shoal (cross-ref)

| Change | Priority | File in pisces |
|---|---|---|
| Read `PISCES_MCP_SOCKETS` and register as MCP clients | P1 | `packages/coding-agent/src/main.ts` |
| `socket_env` protocol: accept `unix://` or bare path | P1 | same |
| `pisces.json` `[mcp]` section: named socket entries | P2 | config schema |

#### What shoal does NOT need to change

- Session lifecycle, worktree management, SQLite state — all tool-agnostic
- The `watcher.py` tmux pane scraper — works with any pattern-based tool
- The `mcp_pool.py` server pool itself — pisces connects as a client, not a pool member
- Remote sessions, API server, journal system — all work with any tool profile

---

## File map: what changes where

### In this repo (pisces / oh-my-pi fork)

| File | Change |
|---|---|
| `packages/coding-agent/src/modes/print-mode.ts` | P0.1: session finalization, P0.2: emit sessionFile |
| `packages/coding-agent/src/cli/args.ts` | P0.3: `--mode=json` fix, P1.6: `--session-dir`, P1.7: `--no-provider-discovery`, P1.9: `--agent` |
| `packages/coding-agent/src/session/session-storage.ts` | P0.1: add `finalize()` method |
| `packages/coding-agent/src/lobster/tools.ts` | P0.4: messageUser + memorySearch extension |
| `packages/coding-agent/src/lobster/index.ts` | P0.4: extension loader for lobster mode |
| `packages/coding-agent/src/main.ts` | P1.7: provider discovery flag wiring; P1: PISCES_MCP_SOCKETS |

### In lobster-party

| File | Change |
|---|---|
| `cmd/lobster-loop/src/grpc.rs` | P0.5: pisces output parsing, new flag invocation |
| `cmd/lobster-loop/src/opencode_runtime.rs` | P0.5: rename to `pisces_runtime.rs`, update binary path |
| `config/opencode-runtime/tools/agent.ts` | P0.4: remove (replaced by pisces built-in lobster extension) |
| `config/opencode-runtime/opencode.json` | rename to `pisces.json`, update schema |
| `config/opencode-runtime/agent/lobster-runtime.md` | keep as-is (portable Markdown) |

### In shoal-cli

| File | Change |
|---|---|
| `examples/config/tools/pisces.toml` | new — pisces tool definition |
| `examples/config/templates/pisces-dev.toml` | new — interactive dev template |
| `examples/config/robo/pisces-robo.toml` | new — robo profile using pisces |
| `src/shoal/services/mcp_pool.py` | inject `PISCES_MCP_SOCKETS` env var when `socket_env` set |
| `src/shoal/services/lifecycle.py` | `{pisces_config}` interpolation in startup command |
| `ROADMAP.md` | update omp note to reference pisces + this plan |

---

## What to leave alone

- Everything upstream from `lobster-loop` (clawplexer, auth, QMD, conversation store)
- The gRPC protobuf schema — `TurnRequest`/`TurnResponse` unchanged
- `AGENTS.md`, skills, rules, instructions — already portable Markdown
- The oh-my-pi TUI, interactive mode, browser tools, LSP, IPython — keep as-is
- Shoal's SQLite state, worktree lifecycle, API server — all tool-agnostic

---

## Upstream sync strategy

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
git merge upstream/main  # periodically, after review
```

Pisces changes are intentionally minimal and surgical (print-mode, CLI args,
one new `src/lobster/` module) to minimize merge conflicts with upstream.

---

## Open questions for next session

1. Should `pisces` be the binary name or keep `omp`? (cosmetic but affects sandbox rootfs)
2. Session chain model: store only "latest" session ID per thread, or store the
   full chain? (Currently lobster-loop stores latest; that's sufficient for resume)
3. Should pisces be published to npm under a `@pisces/` scope, or is a binary
   distribution in the sandbox rootfs sufficient?
4. Upstream oh-my-pi has an ACP mode — is there value in using ACP instead of
   the custom lobster extension for `messageUser`? ACP already maps tool events
   to structured session notifications, which overlaps with what messageUser does
   for status streaming.
5. The `pisces.json` schema extends `opencode.json` — should pisces remain
   compatible with `opencode.json` (so existing lobster configs work without
   renaming), or should the schema break cleanly?
6. Shoal MCP socket injection: should `PISCES_MCP_SOCKETS` be a colon-delimited
   list of raw Unix socket paths, or a JSON array of `{name, socket}` objects
   so pisces can surface tool names correctly in the TUI?
7. Should the shoal-cli pisces tool profile ship in the main repo (as an example)
   or in a `pisces` npm package as a shoal plugin? The latter would let pisces
   install manage its own shoal integration.
