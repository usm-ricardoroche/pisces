# Pisces Roadmap

See [PLAN.md](PLAN.md) for the full lobster-party + shoal integration plan.
This file tracks the longer-arc architecture work.

---

## Near-term: lobster-party integration (P0/P1)

Get pisces working as a drop-in replacement for opencode in lobster-loop.
All items tracked in PLAN.md.

**P0 blockers (pisces-side — all done; lobster-party items pending in that repo):**
- Fix session writer drain in `-p` mode (done in pisces)
- Emit `sessionFile` in `agent_end` event (done in pisces)
- Fix `--mode=json` equals-syntax flag parsing bug; also add loud error on unrecognized mode values (done in pisces)
- Port `messageUser` + `memorySearch` tools to pisces extension API (done in pisces)
- Update lobster-loop `grpc.rs` output parsing for pisces event schema (lobster-party repo — pending)
- Persist session ID→thread mapping in lobster-loop across restarts (lobster-party repo — pending)

**P1 quality-of-life — DONE:**
- `--no-provider-discovery` flag (already implemented)
- `--agent <name>` flag (already implemented)
- Structured error JSON on exit code 1: `fatalError()` helper + top-level catch in `launch.ts`; error codes: `INVALID_ARG`, `NO_MODEL`, `STARTUP_ERROR`, `TURN_FAILED`
- `--session-dir` validated end-to-end (fully wired via `cfff626ba`; PLAN.md test was stale)

**Shoal integration:** Shoal-P0 (tool profile) and Shoal-P1 (`PISCES_MCP_SOCKETS` injection) are complete.
Shoal-P2 (templates, robo profile, config interpolation) and Shoal-P3 (gRPC session backend) are nice-to-have, not started.

## Embedder-grade platform hardening (next major arc)

> Start with Epic 1 and Epic 2. Epic 3 is designed alongside Epic 2 because budget enforcement depends on the same usage and telemetry plumbing.

> Design doc: [docs/verified-task-execution-observability.md](docs/verified-task-execution-observability.md)

### Epic 1. Verified isolated task execution (P0) — DONE

- Added first-class verification policies to isolated `task` runs.
- Applies the subagent patch inside the isolated workspace, runs LSP and/or command checks, returns structured `VerificationResult` with attempt metadata.
- Persists per-attempt logs as artifacts (`${taskId}.verify.a${n}-${i}-${name}.log`).
- One bounded repair retry driven by `task-verification-repair.md` prompt with failure context.
- Six new `AgentSessionEvent` types: `subagent_start`, `subagent_end`, `subagent_verification_start`, `subagent_verification_end`, `subagent_repair_start`, `subagent_repair_end`.
- `docs/rpc.md` updated with verification param shapes and event schemas.

### Epic 2. Standard telemetry bridge (P0) — DONE

- `RuntimeTelemetryAdapter` interface + `NoopTelemetryAdapter` default (no-op unless configured).
- `OtelTelemetryAdapter`: pure OTLP/JSON over HTTP, no `@opentelemetry/*` SDK dependency.
- Full span hierarchy: `pisces.session > pisces.turn > pisces.tool_call`; also `pisces.auto_retry`, `pisces.auto_compaction`, `pisces.ttsr_interrupt`, `pisces.subagent_run > pisces.subagent_verification > pisces.subagent_verification.command`.
- `AgentSessionEvent` union enriched: `TurnStartEvent` (with `turnIndex`/`timestamp`), `TurnEndEvent`, `AgentEndEvent` (with `sessionId`/`sessionFile`).
- `#emitExtensionEvent` now returns enriched event so adapter receives fully-populated spans.
- `getAdapter().onEvent(event)` called from `#emit`; `getAdapter().shutdown()` called from `dispose()`.
- Three new settings: `telemetry.enabled`, `telemetry.endpoint`, `telemetry.serviceName`.
- Adapter initialized from settings in `sdk.ts` when `telemetry.enabled = true`.

### Epic 3. Budget policy and enforcement (P0.5) — DONE

- `RunBudgetPolicy` with 7 limit dimensions: `maxWallTimeMs`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxToolCalls`, `maxSubagents`.
- `BudgetController` accumulates live counters from the `AgentSessionEvent` stream; emits `budget_warning` (at `warnAtRatio`, default 80%) and `budget_exceeded` events idempotently.
- Hard enforcement: `AgentSession.prompt()` rejects new turns; `task` tool aborts subagent spawns and repair retries when budget is exceeded.
- Eight new settings under `task.budget.*`; controller is only instantiated when at least one limit is configured.
- `docs/rpc.md` updated with `BudgetSnapshot` field table, event shapes, and settings reference.

### Epic 4. Hybrid repo retrieval (P1) — PARTIALLY DONE

- Build a retrieval pipeline that combines `grep`, `ast_grep`, `lsp`, and optional semantic reranking.
- Keep deterministic candidate generation as the default; semantic ranking reranks candidates instead of replacing structural search.
- Return provenance-scored hits rather than opaque vector-only results.
- `hybrid_search` tool ships: unified `grep` + `ast_grep` + `lsp` retrieval with provenance scoring.
- Semantic reranking pending (optional layer on top of deterministic candidate generation).

### Epic 5. Session replay inspector (P1) — PARTIALLY DONE

- Expose session tree movement, branch summaries, tool timelines, TTSR injections, retries, and compactions as replayable structured data.
- Ship the headless inspection layer first; UI visualizers remain a thin consumer on top of the same replay model.
- Headless `pisces session inspect <file>` CLI ships; supports structured session replay and analysis.
- UI visualizers (branch summaries, tool timelines, TTSR injection views) remain future work on top of the same replay model.

### Epic 6. Vision-assisted UI triage (P2)

- Build a workflow that combines screenshot/image inputs, browser observation, and repo retrieval to map visual bugs to likely components and files.
- Treat this as an extension/workflow layer built on top of existing blob, artifact, browser, and image-inspection primitives.

---

## Session finalization — corrected understanding

**The bug is not a `.tmp` → `.jsonl` rename.** The session file is created at the
final `.jsonl` path from the start (`#newSessionSync` in `session-manager.ts:1687`).
The `.tmp` pattern only appears inside `#writeEntriesAtomically` for atomic
full-file rewrites — it is not the primary write path.

**The actual problem:** `dispose()` in `agent-session.ts` calls
`sessionManager.close()`, which queues a persist task via `#queuePersistTask`.
If Bun's event loop exits before that queue drains, the final `fsync`/`close`
of the append-writer is skipped. The file content may be complete but is not
guaranteed to be durable.

**The fix (TS-level):** Before `session.dispose()` in `print-mode.ts`, explicitly
await the session manager's close and ensure the persist queue has drained:

```typescript
// Already called, but must be confirmed to drain synchronously before exit:
await session.dispose()  // calls sessionManager.close() → drains persist queue
```

The deeper fix is the Rust N-API session storage crate (see §Architecture below),
which removes the async queue entirely.

---

## Event taxonomy — `agent_end` vs `turn_end`

Both events exist in the current codebase. They are distinct:

| Event | When fired | Contents |
|---|---|---|
| `turn_end` | After each LLM response turn | `{ type, turnIndex, message, toolResults }` |
| `agent_end` | After the full agent loop completes | `{ type, messages }` |

For lobster-party integration, the response text lives in `turn_end.message.content`.
`agent_end` fires after `turn_end` and is the correct place to emit `sessionFile`
because at that point all turns are complete and the session is about to be closed.

**Required change (P0.2):** Add `sessionId` and `sessionFile` to the `AgentEndEvent`
type and populate them in `agent-session.ts` before emitting the event to subscribers.
`print-mode.ts` already forwards all events to stdout in JSON mode — no additional
change needed there once the event carries the field.

Current `AgentEndEvent` shape (from `extensions/types.ts:502`):
```typescript
{ type: "agent_end"; messages: AgentMessage[] }
```

Target shape:
```typescript
{ type: "agent_end"; messages: AgentMessage[]; sessionId: string; sessionFile: string | undefined }
```

---

## Architecture: Rust extension strategy

The existing Rust N-API approach (`crates/pi-natives`) is the right architecture.
The TypeScript agent loop is not a performance bottleneck — LLM round-trips and
tool execution dominate. The right moves are **new Rust capabilities**, not
replacing TypeScript that already works.

### 1. Rust-owned session storage crate

**Target:** `crates/pi-session` (new)

Unify `packages/coding-agent/src/session/session-storage.ts`,
`agent-storage.ts`, and the existing `crates/pi-natives/src/search_db.rs` into
a single Rust crate that owns:

- JSONL session file lifecycle (write, fsync, atomic write-to-tmp-then-rename as a deliberate upgrade)
- Session chain index (maps session ID → file path, supports `--resume <id>` lookup)
- BM25 search index over session content (currently in `search_db.rs`)
- Session metadata (ID, parent ID, cwd, model, timestamps)

**Why this is the right Rust boundary:** The root cause of the session finalization
bug is that Bun's event loop may exit before the async persist queue drains. Owning
session I/O in Rust via N-API means all writes are synchronous blocking calls —
no async queue, no GC timing, no event loop exit race. `finalize()` becomes a
single `fsync` + optional `rename` that cannot be skipped.

Note: unlike the current TS code (which writes directly to `.jsonl`), the Rust
crate should introduce write-to-tmp-then-rename as a deliberate durability upgrade,
not because the current code works that way.

**Interface from TypeScript:**

```typescript
import { SessionStorage } from '@oh-my-pi/pi-natives'  // added to existing addon

const storage = new SessionStorage({ dir: '/path/to/sessions' })
storage.write(event)       // synchronous N-API call, buffered in Rust
storage.flush()            // flush buffer to OS
storage.fsync()            // fsync to disk
storage.finalize()         // fsync + atomic rename tmp → .jsonl, returns final path
storage.resume(id)         // look up session file by 16-char hex ID
```

**Packaging decision:** Session storage stays inside `pi-natives` as a new module
(`crates/pi-natives/src/session_storage.rs`). Not a separate npm addon — avoids
two-addon version management while maintaining a clean internal boundary.
`search_db.rs` can be an internal sibling module.

---

### 2. `--mode grpc` — Rust gRPC server mode

**Target:** `crates/pi-grpc` (new) + thin TS integration

Currently, lobster-loop spawns `pisces -p` as a **subprocess per turn**. Each turn
pays:
- Bun runtime cold start: ~150–200ms
- `PI_CODING_AGENT_DIR` config load: ~20ms
- Provider initialization: ~30ms

Total fixed overhead per turn: **~200–250ms** on top of the LLM latency.

With `--mode grpc`, pisces starts once and accepts turns over gRPC, keeping the
Bun runtime warm:

```
lobster-loop                         pisces (long-lived)
   │                                       │
   │── TurnRequest (gRPC) ──────────────▶  │
   │                                       │  ← no cold start
   │◀─ TurnResponse stream ────────────────│
   │                                       │
   │── TurnRequest ──────────────────────▶ │
   │◀─ TurnResponse stream ────────────────│
```

**Design (detailed):** See §gRPC mode service design below.

---

### 3. Persistent LSP connections across turns

**Depends on:** `--mode grpc` (item 2 above)

Currently each `-p` subprocess starts and stops LSP servers fresh. With warm
workers in gRPC mode, LSP connections survive the turn boundary. The language
server's index is already built — go-to-definition and diagnostics are instant
from turn 2 onward.

This is a zero-code change in pisces once gRPC mode exists — it falls out
naturally from workers staying alive.

---

## gRPC mode service design

### Transport layer

`crates/pi-grpc` implements a Tonic gRPC server. The proto surface mirrors
lobster-loop's existing service shape:

```protobuf
service Pisces {
  rpc Turn(TurnRequest) returns (stream TurnEvent);
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc Status(StatusRequest) returns (StatusResponse);
}

message TurnRequest {
  string prompt         = 1;
  string model          = 2;
  string session_id     = 3;  // empty = new session
  string agent          = 4;  // empty = default agent
  map<string,string> env = 5; // per-turn env overrides
}

message TurnEvent {
  string json = 1;  // raw AgentSessionEvent JSON line
}

message HealthResponse { bool ok = 1; }
message StatusResponse {
  int32 workers_total = 1;
  int32 workers_idle  = 2;
  repeated WorkerStatus workers = 3;
}
message WorkerStatus {
  string id      = 1;
  string state   = 2;  // "idle" | "busy" | "starting" | "crashed"
  string session = 3;  // current session ID if busy
}
```

### Worker pool

The Rust layer manages a pool of warm `pisces --mode rpc` Bun worker processes.
The RPC protocol (`docs/rpc.md`) is already fully implemented — workers speak
JSONL over stdin/stdout.

**Pool lifecycle:**

```
pi-grpc startup
  └─ spawn N workers: pisces --mode rpc [--agent <name>] [--model <model>]
       each worker: stdin=pipe, stdout=pipe, env=base config
       each worker: waits for { type: "prompt", message: "..." } commands

TurnRequest arrives
  └─ acquire idle worker (or queue if all busy)
  └─ send: { id: "t1", type: "prompt", message: <prompt> }
  └─ if session_id: send first: { id: "s1", type: "new_session" / resume via args }
  └─ stream TurnEvent for each AgentSessionEvent line on worker stdout
  └─ stop streaming on agent_end event
  └─ release worker back to pool
```

**Session identity across turns:**

Workers are stateful — they hold an open session. The Rust pool must track:

```
worker_id → { state, current_session_id, last_active }
session_id → worker_id   (while turn is active)
```

On `TurnRequest`:
- If `session_id` is provided: acquire the worker that holds that session, or any
  idle worker and send `{ type: "new_session", parentSession: session_id }` to
  fork from it (same behavior as `-p --resume`).
- If `session_id` is empty: acquire any idle worker, start fresh.

The session ID for the new turn is extracted from the first `agent_start` event
or from the `agent_end.sessionId` field once P0.2 is implemented. This ID is
returned to lobster-loop so it can update its thread→session map.

**Pool sizing and configuration:**

```bash
NS:pisces --mode grpc --port 50051 --workers 4
JP:pisces --mode grpc --socket /var/run/pisces.sock --workers 2
```

Minimum viable: `--workers 1` (serializes all turns, zero concurrency). Useful
for single-claw sandboxes.

**Worker crash recovery:**

If a worker process exits unexpectedly:
1. Mark worker as `crashed`.
2. Return an error `TurnEvent` to the active caller if one exists.
3. Replace with a new worker after a brief backoff.
4. Session state on the crashed worker is lost — the session JSONL on disk is
   intact (written by the Rust session storage crate), so the next turn can
   `--resume` from the last finalized session.

This is the primary reason `pi-session` (item 1) and `pi-grpc` (item 2) are
co-dependent: durable session files are required for crash recovery in gRPC mode.

**Worker health:**

The `Health` RPC returns `ok: true` if at least one worker is alive. The `Status`
RPC exposes per-worker state for monitoring. Lobster-loop's `pisces_runtime.rs`
can poll `Health` to decide when to start routing turns.

### Startup modes

```bash
pisces --mode grpc --port 50051           # TCP (default for remote)
pisces --mode grpc --socket /var/run/pisces.sock  # Unix socket (preferred in sandbox)
```

Unix socket is preferred in the lobster sandbox because:
- No port allocation conflicts
- Path is predictable and injected into the sandbox via `pisces_runtime.rs`
- Slightly lower latency than loopback TCP

### Interaction with `pi-session` crate

gRPC mode makes the session durability requirement concrete:

- Workers write session events via `pi-session` (synchronous N-API)
- If a worker crashes mid-turn, the session file has all events up to the crash
- On `agent_end`, `pi-session.finalize()` is called → `fsync` + rename
- The finalized path is returned in `agent_end.sessionFile`
- Rust pool extracts this, stores it in `session_id → file_path` index
- Next `TurnRequest` with that `session_id` can resume from the file

### Connection from lobster-loop

`lobster-loop/cmd/lobster-loop/src/pisces_runtime.rs` (renamed from
`opencode_runtime.rs`) manages the gRPC server lifecycle:

```rust
// Startup
let pisces = PiscesRuntime::start(PiscesConfig {
    binary: "/usr/local/bin/pisces",  // omp symlink also works during transition
    socket: "/var/run/pisces.sock",
    workers: 2,
    args: vec!["--mode", "grpc", "--no-provider-discovery"],
})?;
pisces.wait_ready(Duration::from_secs(10)).await?;

// Per-turn  (replaces subprocess spawn)
let mut stream = pisces.client.turn(TurnRequest {
    prompt,
    model,
    session_id: thread.last_session_id.clone().unwrap_or_default(),
    ..Default::default()
}).await?;

// Consume stream
while let Some(event) = stream.next().await {
    let evt: AgentSessionEvent = serde_json::from_str(&event.json)?;
    // same parsing as today
}
```

This is a **drop-in replacement** for the subprocess spawn in `grpc.rs` — the
event parsing and session ID extraction are identical.

---

## Shoal integration — prioritized

Shoal items are elevated here because some enable developer workflows immediately,
independent of lobster-party status.

### Priority tiers for shoal work

**Shoal-P0 (enables pisces as a shoal tool today) — DONE:**
- Add `examples/config/tools/pisces.toml` to shoal repo — lets developers use
  pisces in shoal sessions with correct status detection patterns

**Shoal-P1 (MCP pool injection — needed for shared MCP servers) — DONE:**
- Implement `PISCES_MCP_SOCKETS` env var in pisces `main.ts`
  (read colon-delimited Unix socket paths, register each as MCP client)
- Update `src/shoal/services/mcp_pool.py` to inject `PISCES_MCP_SOCKETS` when
  `tool.mcp.socket_env` is set in the tool profile
- Document `unix://` vs bare path format decision (see §Risk: socket format below)

**Shoal-P2 (templates and robo — nice to have):**
- Add `examples/config/templates/pisces-dev.toml`
- Add `examples/config/robo/pisces-robo.toml`
- `src/shoal/services/lifecycle.py`: `{pisces_config}` interpolation

**Shoal-P3 (depends on gRPC mode):**
- Update shoal `ROADMAP.md` to reference pisces gRPC mode as future persistent
  session backend for shoal-managed pisces sessions

### Concrete pisces changes for shoal

| Change | Priority | File |
|---|---|---|
| Read `PISCES_MCP_SOCKETS`, register as MCP clients | Shoal-P1 | `packages/coding-agent/src/main.ts` |
| Log warning if `PISCES_MCP_SOCKETS` is set but feature not compiled | Shoal-P1 | same |
| `pisces.json` `[mcp]` section: named socket entries | Shoal-P2 | config schema |

---

## Risks and mitigations

### Risk 1: Bun event loop exit before persist queue drains

**Status:** Root cause of the P0 session finalization bug.

**Mitigation (near-term):** In `print-mode.ts`, add an explicit `process.stdout`
drain _and_ verify `sessionManager.close()` is fully awaited. Add a Bun `beforeExit`
hook as a safety net:

```typescript
process.on("beforeExit", () => {
  // If we reach here with an undrained persist queue, log a warning.
  // The Rust pi-session crate will eliminate this entirely.
})
```

**Mitigation (long-term):** `pi-session` Rust crate — synchronous N-API writes
eliminate the async queue entirely.

**Test:** Add a shell regression test: run `pisces -p "hello"`, assert a `.jsonl`
file exists in `$PI_CODING_AGENT_DIR` with non-zero size within 1s of process exit.

---

### Risk 2: Session ID storage across lobster-loop restarts

**Problem:** `--resume <full-id>` requires the exact 16-char hex session ID. If
lobster-loop stores this only in memory, a restart loses the mapping and all
threads lose conversation context.

**Mitigation:** The session ID must be persisted in the conversation store (the
existing lobster-party `TurnRecord` or a separate `thread_session_map` table)
before the turn response is sent to the caller. The write order:

```
1. Receive agent_end (has sessionId)
2. Write TurnRecord + new session_id → conversation store  ← must be durable
3. Return TurnResponse to gRPC caller
```

If step 2 fails, return an error. Do not return success without a durable session ID.

**Owner:** lobster-party repo. Tracked here as a dependency of the pisces
integration being correct end-to-end.

---

### Risk 3: `pisces.json` schema URL is a placeholder

**Problem:** `"$schema": "https://pisces.dev/config.json"` — domain does not
exist. Schema validators will fail or warn.

**Mitigation:** Use a local relative path or omit the `$schema` field entirely
until a real schema is published. Change the example in PLAN.md to:

```json
{ "$schema": "./pisces.schema.json" }
```

or omit it:

```json
{
  "lsp": { "enabled": false },
  "providerDiscovery": { "enabled": false }
}
```

---

### Risk 4: `PISCES_MCP_SOCKETS` silently ignored if not implemented — RESOLVED

**Status: Resolved.** `PISCES_MCP_SOCKETS` is implemented. Pisces reads the env var on startup,
splits on `:`, and registers each path as a Unix socket MCP client. No warning-and-bail path needed.
The integration gap this risk described no longer exists.

---

### Risk 5: `PISCES_MCP_SOCKETS` format — colon-delimited vs JSON

**Problem:** Open question from PLAN.md §6. Colon-delimited paths break if any
socket path contains a colon (uncommon on Unix but possible in container paths).
JSON array is unambiguous but more verbose for a simple env var.

**Decision:** Use null-byte delimiter (`\0`) in the env var for unambiguity, with
a shoal-side helper that builds the string. Alternatively, accept both formats:
try JSON parse first, fall back to colon-split.

**Recommended resolution:** Colon-delimited is fine for Unix socket paths in
practice (they never contain colons). Keep it simple. Document the constraint.

---

### Risk 6: Native addon packaging ✓ resolved

**Decision:** Session storage is a new module inside `pi-natives`
(`src/session_storage.rs`), exposed through the existing N-API surface.
No separate addon, no separate build, no version management split.

---

### Risk 7: gRPC mode worker crash loses in-flight turn

**Problem:** If a worker crashes during a turn (OOM, assertion, provider timeout),
the session JSONL has partial data and the caller gets a stream error.

**Mitigation:**
- `pi-session` writes each event synchronously — partial session is readable up
  to the last event before the crash.
- The Rust pool returns a terminal `TurnEvent` with an error JSON line on crash:
  `{ "type": "error", "code": "WORKER_CRASHED", "message": "..." }`
- Lobster-loop handles this as a failed turn (same as exit code 1 today).
- The partial session file is valid for `--resume` up to the last flushed event.
- Caller can retry the turn with the partial session ID.

---

## Distribution

**Current:** Binary artifact only. The sandbox rootfs installs `pisces` as the
primary binary with `omp` as a symlink alias.

**P3 (if pisces is promoted to company tech stack):** Distribute prebuilt
binaries (including native addon `.node` files for each platform) via JFrog
Artifactory. Build pipeline details TBD — instructions to be provided when the
decision is made.

No npm publishing planned.

---

## Upstream sync policy

Track `can1357/oh-my-pi` as upstream remote:

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
git merge upstream/main  # after review
```

Pisces changes are scoped to minimize conflict surface:
- `src/lobster/` — new directory, never conflicts
- `src/modes/print-mode.ts` — targeted patches to session drain + event emission
- `src/cli/args.ts` — additive flags only
- `crates/pi-natives/src/session_storage.rs` — new file, no upstream equivalent
- `crates/pi-grpc/` — new crate, no upstream equivalent

The TypeScript agent loop, TUI, tool implementations, MCP stack, and bundled
agents are **left alone** — updated from upstream as-is.
