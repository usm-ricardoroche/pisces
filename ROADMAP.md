# Pisces Roadmap

See [PLAN.md](PLAN.md) for the full lobster-party + shoal integration plan.
This file tracks the longer-arc architecture work.

---

## Near-term: lobster-party integration (P0/P1)

Get pisces working as a drop-in replacement for opencode in lobster-loop.
All items tracked in PLAN.md.

**P0 blockers:**
- Fix session finalization in `-p` mode (`.tmp` → `.jsonl` before exit)
- Emit `sessionFile` in `agent_end` event
- Fix `--mode=json` equals-syntax flag parsing bug
- Port `messageUser` + `memorySearch` tools to pisces extension API
- Update lobster-loop `grpc.rs` output parsing for pisces event schema

**P1 quality-of-life:**
- `--no-provider-discovery` flag
- `--agent <name>` flag
- Structured error JSON on exit code 1
- `--session-dir` flag that actually works

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

- JSONL session file lifecycle (write, flush, fsync, atomic rename `.tmp` → `.jsonl`)
- Session chain index (maps session ID → file path, supports `--resume <id>` lookup)
- BM25 search index over session content (currently in `search_db.rs`)
- Session metadata (ID, parent ID, cwd, model, timestamps)

**Why this is the right Rust boundary:** File I/O with fsync guarantees is exactly
where Rust earns its keep. The P0.1 session finalization bug (`finalize()` call
not completing before process exit) is fundamentally a Node.js async/GC timing
issue. Owning this in Rust via N-API means `finalize()` is a synchronous call
with a `File::sync_all()` + `fs::rename()` that cannot be interrupted.

**Interface from TypeScript:**

```typescript
import { SessionStorage } from '@pisces/native'

const storage = new SessionStorage({ dir: '/path/to/sessions' })
storage.write(event)       // synchronous N-API call, buffered in Rust
storage.flush()            // flush buffer to OS
storage.fsync()            // fsync to disk
storage.finalize()         // atomic rename .tmp → .jsonl, returns final path
storage.resume(id)         // look up session file by 16-char hex ID
```

**Dependency note:** `search_db.rs` already exists in `pi-natives`. Extract it
into a dedicated crate so session storage doesn't pull in the full native addon.

---

### 2. `--mode grpc` — Rust gRPC server mode

**Target:** `crates/pi-grpc` (new) + thin TS integration

Currently, lobster-loop spawns `omp -p` as a **subprocess per turn**. Each turn
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

**Design:**

The gRPC surface mirrors lobster-loop's existing proto (`LobsterLoop` service):

```protobuf
service Pisces {
  rpc Turn(TurnRequest) returns (stream TurnEvent);
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc Status(StatusRequest) returns (StatusResponse);
}
```

The Rust crate (`crates/pi-grpc`) implements the Tonic server. It manages a pool
of warm Bun worker processes (one per configured model/agent combination) and
dispatches turns to them via `--mode rpc` stdin/stdout JSONL. The Rust layer
handles:
- gRPC server lifecycle (Tonic)
- Worker process pool (one warm `omp --mode rpc` per slot)
- Turn routing to available worker
- Event translation: RPC JSONL → gRPC stream
- Session ID tracking across turns

**Why Rust for the gRPC layer:** Tonic is already used in lobster-loop. Keeping
the same Tonic-based gRPC stack in pisces means lobster-loop's `grpc.rs` can
connect directly — replacing subprocess spawn with a gRPC client call. The
connection upgrade from subprocess-per-turn to persistent gRPC is entirely in
`grpc.rs`; the pisces TypeScript agent loop is unchanged.

**Startup modes:**

```bash
omp --mode grpc --port 50051          # long-lived gRPC server
omp --mode grpc --socket /var/run/pisces.sock  # Unix socket variant
```

lobster-loop's `pisces_runtime.rs` manages starting/stopping the grpc process
and injecting the socket path into the sandbox.

**Estimated gain:** Eliminates ~200ms fixed overhead per turn. For a 10-turn
conversation, saves ~2s of pure startup waste. More importantly, warm workers
means the agent's LSP connections, search indices, and MCP connections survive
across turns — currently all of these are rebuilt from scratch per turn.

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

## Upstream sync policy

Track `can1357/oh-my-pi` as upstream remote:

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
git merge upstream/main  # after review
```

Pisces changes are scoped to minimize conflict surface:
- `src/lobster/` — new directory, never conflicts
- `src/modes/print-mode.ts` — targeted patches to session finalization + event emission
- `src/cli/args.ts` — additive flags only
- New crates (`pi-session`, `pi-grpc`) — no upstream equivalent, no conflicts

The TypeScript agent loop, TUI, tool implementations, MCP stack, and bundled
agents are **left alone** — updated from upstream as-is.
