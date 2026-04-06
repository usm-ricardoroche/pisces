# Full Feature Reference

Complete reference for every major subsystem in pisces. Organised into three tiers:
- **pisces-native** — built or modified in this fork
- **oh-my-pi core** — the pi-coding-agent package
- **oh-my-pi platform** — TUI, AI, agent-core, natives, and other packages

---

## Pisces-native features

### lobster-party integration mode

`PISCES_LOBSTER_MODE=1` activates the lobster extension, injecting two additional LLM-callable tools that communicate with the majordomo-do sidecar over a Unix socket:

**`messageUser`** — sends a message directly into the user-facing lobster-party chat interface. Used by the agent to ask clarifying questions or surface status updates without polluting the session transcript.

**`memorySearch`** — queries the majordomo-do memory index for project-relevant context (technical decisions, prior conversation summaries, recurring workflows). Retrieval is scoped to the current run channel and retried up to 4 times with exponential backoff on transient socket failures.

Both tools are loaded via `CreateAgentSessionOptions.customTools` and are absent when `PISCES_LOBSTER_MODE` is unset — zero overhead in non-lobster deployments.

Environment variables:
- `PISCES_LOBSTER_MODE=1` — enable the extension
- `PISCES_MAJORDOMO_SOCKET` (or `MAJORDOMO_SOCKET`) — Unix socket path for the sidecar
- `PISCES_RUN_CHANNEL_KEY` (or `RUN_CHANNEL_KEY`) — per-run routing key

### `agent_end` session metadata

`AgentEndEvent` carries `sessionId` and `sessionFile` alongside `messages`. This lets any RPC or JSON-mode consumer extract the session file path at turn completion without parsing the session header separately — the primary hook for lobster-loop's conversation persistence model.

```json
{ "type": "agent_end", "sessionId": "abc123…", "sessionFile": "/path/to/sessions/…jsonl", "messages": […] }
```

### `--mode=json` flag fix

The upstream `--mode json` (space form) worked; `--mode=json` (equals form) silently fell back to text mode. Both forms now parse identically. Unrecognised mode values emit a loud error to stderr: `Unknown mode: <x>. Valid values: text, json, rpc, acp`.

### `--agent <name>` flag

Selects which bundled or discovered agent definition runs in print mode. Matches opencode's `--agent=<name>` interface, letting lobster-loop dispatch the `plan` agent for read-only planning turns vs the default `task` agent for execution turns.

### `--no-provider-discovery` flag

Disables automatic provider discovery from environment variables. When set, the agent only loads providers explicitly configured in `config.yml`. Required for lobster sandbox deployments where ambient `AWS_*` and `ANTHROPIC_*` variables must not override the intended provider.

### `--session-dir <path>` (wired)

Redirects session storage for the process lifetime. Lets lobster-loop point each claw sandbox at an isolated session directory without relying on `PI_CODING_AGENT_DIR` and a full config mount. The flag is parsed and wired end-to-end to `SessionManager`.

### Shoal team orchestration

Shoal provides wave-based multi-agent team coordination. Requires `shoal-mcp-server` on PATH. Enabled via `shoal.enabled: true` (default); fails clearly with a diagnostic error if Shoal is absent.

**`/team run <file.yaml>`** — parses a workflow YAML and dispatches agents in sequential waves. Each agent runs in its own Shoal session with a dedicated tmux pane and, when requested, an isolated git worktree. Waves execute serially; all agents in a wave must complete before the next wave starts.

**`ShoalOrchestrator`** — drives wave execution. Polls per-agent completion via `ShoalMcpBridge`, aggregates results, and surfaces structured output per agent. All Shoal interactions are centralised in `src/shoal/` — no direct SQLite reads elsewhere.

**Action gating** — agents call `shoal_request_action` before any destructive operation (write, delete, deploy). The pending action is surfaced in the TUI and blocks the next wave from starting. The operator resolves it via `/team approve <id>` or `/team deny <id>` from any pisces session. Denied actions propagate as failures to the requesting agent.

**Correlation IDs** — every `/team run` is assigned a `wf_<16-hex>` workflow ID at dispatch. The ID threads through the TUI widget header, per-agent progress lines, and the final result summary, making it trivial to correlate log output across concurrent runs.

**Awareness context injection** — at session start, `ShoalMcpBridge` attempts to retrieve live Shoal session data and injects a compact summary into the system prompt. Best-effort: skipped silently on Shoal unavailability.

**Shared MCP socket pool** — when `PISCES_MCP_SOCKETS` is set, pisces connects to existing Unix socket MCP servers instead of spawning new processes. Enables shared MCP state across a fleet of agents managed by Shoal.

Environment variables:
- `PISCES_MCP_SOCKETS` — colon-separated Unix socket paths (e.g., `/tmp/mcp.sock:/tmp/mcp2.sock`)
- `shoal.enabled` — enable/disable Shoal extension (default: `true`)

Or configure via `pisces.mcpSockets` in config:

```json
"pisces": {
  "mcpSockets": ["/tmp/mcp.sock", "/tmp/mcp2.sock"]
}
```

→ [PISCES_SHOAL_EXECUTION_MODEL.md](/PISCES_SHOAL_EXECUTION_MODEL) — task vs `/team` decision rule, integration boundary, action gating protocol

### Budget policy enforcement

`RunBudgetPolicy` applies per-run resource limits across 7 dimensions:

| Setting (`task.budget.*`) | Description |
|:---|:---|
| `maxWallTimeMs` | Wall-clock time limit for the run |
| `maxInputTokens` | Total input tokens consumed |
| `maxOutputTokens` | Total output tokens generated |
| `maxTotalTokens` | Combined input + output tokens |
| `maxCostUsd` | Estimated cost ceiling in USD |
| `maxToolCalls` | Total tool invocations |
| `maxSubagents` | Nested subagent dispatches |

`BudgetController` tracks live consumption and emits a `budget_warning` event at 80% of any limit. Hard enforcement triggers in the task tool — the run is terminated with a structured error before the limit is exceeded. Zero overhead when no budget is configured.

### Standard telemetry bridge

`OtelTelemetryAdapter` emits OpenTelemetry-compatible spans over HTTP without a full OTel SDK dependency. Payloads are OTLP/JSON POSTed to `telemetry.endpoint`.

Span hierarchy:
```
pisces.session
  └─ pisces.turn
       └─ pisces.tool_call
  └─ pisces.subagent_run
       └─ pisces.subagent_verification
```

LLM spans carry a `gen_ai_tool_definitions` attribute listing the active tool manifest — visible in Jaeger and Datadog without additional instrumentation.

Settings:
- `telemetry.enabled` — activate the bridge (default: `false`)
- `telemetry.endpoint` — OTLP/HTTP collector URL
- `telemetry.serviceName` — service name tag on all spans

No spans are emitted and no network calls are made when `telemetry.enabled` is false.

### Verified isolated task execution

Isolated task runs (those with `isolated: true`) support configurable verification policies applied after the agent completes. The `VerificationResult` is structured — callers can distinguish "agent finished but verification failed" from "agent crashed".

Verification pipeline:
1. **LSP check** — runs diagnostics on files touched during the task.
2. **Command checks** — arbitrary shell commands declared in the policy (e.g., `bun check:ts`, `pytest -x`).

On failure, one bounded repair retry is attempted: the original agent is resumed with the verification errors injected as context. Per-attempt output is written to a log artifact. The retry cap is fixed — no unbounded repair loops.

Six new session event types emitted during isolated task lifecycle:

| Event | Fires when |
|:---|:---|
| `subagent_start` | Subagent session begins |
| `subagent_end` | Subagent session completes (success or failure) |
| `subagent_verification_start` | Verification policy begins |
| `subagent_verification_end` | Verification policy completes |
| `subagent_repair_start` | Repair retry begins |
| `subagent_repair_end` | Repair retry completes |

### Session inspect CLI

`pisces session inspect <file.jsonl>` opens a session JSONL file for replay and analysis. Useful for post-mortem review of agent runs, extracting structured outputs, and verifying event sequences without re-running the agent.

### Hybrid search tool

`hybrid_search` combines grep, ast-grep, and LSP in a single retrieval pass. Returns results with provenance scoring — each hit is annotated with which search backend found it and at what confidence. Avoids redundant parallel searches for the common case where all three backends agree.

### Presets

pisces supports configuration presets for different deployment scenarios:

| `pisces.preset` | Activates |
|:---|:---|
| `lobster` | `lobsterMode: true`, `noProviderDiscovery: true` — for lobster-party pipeline deployments |
| `headless` | Minimal TUI, reduced interactive features — for server/CI environments |
| `minimal` | No extensions, no Shoal — barebones execution for constrained environments |

### Idle compaction

When a session is idle (no active turn) and the context window is above the compaction threshold, pisces automatically triggers compaction. No manual `/compact` is required. The idle check fires at the end of each turn; compaction uses the same configurable `firstKeptEntryId` boundary as manual compaction.

### Session observer overlay

Ctrl+S opens a live overlay showing all active subagent sessions for the current pisces process. Each row displays session name, status, current tool in flight, and a progress indicator. The overlay subscribes to two internal channels:
- `TASK_SUBAGENT_LIFECYCLE_CHANNEL` — `started` / `completed` / `failed` lifecycle signals
- `TASK_SUBAGENT_PROGRESS_CHANNEL` — in-progress tool activity updates

The overlay updates in real time without blocking the parent session.

### Auto-resume

When pisces starts in a directory with an existing session for that working directory, it resumes the most recent session automatically. No `--continue` flag or interactive prompt required. Disable by passing `--new` to force a fresh session.

### Secrets hash token redaction

Secrets detected in display-path output (TUI rendering, JSON event streams) are replaced with `#XXXX#` tokens before delivery to the terminal or caller. Raw session JSONL is unaffected — redaction is applied at the display layer only.

---

## oh-my-pi core (pi-coding-agent)

### Execution modes

| Mode | Flag | Use |
|---|---|---|
| Interactive TUI | (default) | Full terminal UI with PTY, inline images, keyboard nav |
| Print / single-shot | `-p` / `--print` | Send one or more prompts, stream response, exit |
| JSON event stream | `--mode json` | JSONL event stream on stdout for programmatic consumers |
| RPC | `--mode rpc` | Bidirectional JSON-RPC over stdio — full session control |
| ACP | `--mode acp` | Agent Control Protocol mode (in progress) |

Print mode emits the session header as the first JSON line. `agent_end` carries `sessionId` and `sessionFile`. Session files are durable before process exit — the persist queue drains synchronously via `sessionManager.close()` before `dispose()`.

→ [RPC Protocol Reference](/rpc)

### Session model

Every entry — user message, assistant message, tool call, tool result, compaction, branch summary — is a node in an append-only tree keyed by `id`/`parentId`. The active position is `leafId`. The log is never rewritten; branching changes the leaf pointer only.

**Navigation** — `/tree` opens an interactive tree navigator. The active branch path is highlighted; other branches show their last entry as context. Switching branches generates an automatic `BranchSummaryEntry` for the abandoned path.

**Compaction** — when the context window fills, the oldest entries are summarised into a `CompactionEntry` with a configurable `firstKeptEntryId` boundary. Compaction entries are first-class nodes — the full pre-compaction history is never deleted.

**`/handoff`** — generates a structured context summary, creates a new session, and injects the summary as the opening system message. Useful for a clean context start that still carries forward project state.

**Session operations** — export (HTML/markdown), share (read-only link), fork (new session file at current leaf), resume (by session ID or `--continue` for the latest).

→ [Session model](/session) · [Session tree](/session-tree-plan) · [Compaction](/compaction) · [Operations](/session-operations-export-share-fork-resume)

### Time-Traveling Stream Rules (TTSR)

Rules with a `ttsrTrigger` pattern watch the model's token stream. When the pattern matches mid-stream, the generation is interrupted, the rule content is injected at the interruption point, and the generation retries. Rules that never match cost zero tokens. Deduplicated by name; higher-priority provider wins.

→ [TTSR injection lifecycle](/ttsr-injection-lifecycle)

### Parallel subagents

The `task` tool dispatches a typed batch of named agents in parallel, each in its own isolated session. `isolated: true` runs agents in git worktrees and returns diff patches. Spawn depth is enforced — at the limit, the `task` tool is removed from the child's toolset.

**Bundled agents:** `task`, `plan` (read-only), `code-reviewer`, `debug-test-failure`, `fix-pr-comments`, `upgrade-dependency`, `explore`, `oracle`, `librarian`, `quick_task`.

→ [Task agent discovery](/task-agent-discovery)

### Persistent IPython kernel

The `python` tool runs cells through a Jupyter Kernel Gateway. The kernel persists across calls; variables, imports, and state survive between turns. `reset: true` restarts the kernel before the first cell in a call. Rich output — DataFrames, matplotlib figures, Mermaid diagrams, HTML — renders inline. Local gateway auto-starts on demand and is shared across sessions via a coordinator lock.

→ [Python runtime](/python-repl)

### Structured storage: blobs & artifacts

Large outputs and binary data are stored outside the session JSONL:

- **Content-addressed blobs** (`blob:sha256:<hash>`) — global, deduplicated. The same image across multiple sessions is stored once.
- **Session artifacts** — per-session directory. Full tool output and subagent results referenced via `artifact://` URIs. The model requests full content on demand; context stays lean.

→ [Blob and artifact architecture](/blob-artifact-architecture)

### MCP integration

Supports `stdio` and HTTP/SSE transports. Servers connect in parallel at session start with a 250ms fast-startup gate — `DeferredMCPTool` handles are returned for slow servers and resolve in the background. Live refresh via `/mcp` without restart. Exa servers are filtered and their API key is wired to the native Exa tool directly.

→ [MCP runtime lifecycle](/mcp-runtime-lifecycle) · [Protocol & transports](/mcp-protocol-transports) · [MCP config](/mcp-config)

### Extension model

A default-exported TypeScript factory receives `ExtensionAPI` and can register LLM-callable tools, slash commands, keyboard shortcuts, event interceptors (with blocking), and custom TUI renderers. Hot-discovered from `~/.pisces/agent/extensions` and `.pisces/extensions`. Gemini-format `gemini-extension.json` manifests are also supported.

→ [Extensions](/extensions) · [Extension loading](/extension-loading) · [Gemini manifest extensions](/gemini-manifest-extensions)

### Skills

File-backed context packs (`SKILL.md`). Listed in the system prompt by name+description only. Full content is fetched on demand via `read skill://<name>`. Zero upfront token cost for skills that don't fire.

→ [Skills](/skills)

### Hooks

Pre/post tool call interceptors with blocking capability. `HookAPI` is a lighter alternative to extensions for intercept-only use cases. Currently routed through the extension runner in the default CLI startup path.

→ [Hooks](/hooks)

### Plugin marketplace

Install plugins from any Git-hosted catalog in the Claude plugin registry format. Plugins bundle skills, commands, hooks, MCP servers, and LSP server configs as a unit. User scope (`~/.pisces/plugins/`) and project scope (`.pisces/installed_plugins.json`); project scope shadows user scope.

→ [Marketplace](/marketplace)

### Autonomous memory

When enabled, a background pipeline extracts durable knowledge from past sessions and injects a compact summary at each new session start. Phase 1 extracts per-session signal (decisions, constraints, resolved failures); phase 2 consolidates into `MEMORY.md`, `memory_summary.md`, and generated skill playbooks. Retrievable via `memory://root`, `memory://root/MEMORY.md`, and `memory://root/skills/<name>/SKILL.md`.

→ [Memory](/memory)

### Tool runtime details

**Bash** — command normalization extracts trailing `| head`/`| tail` into structured limits. An interceptor can block commands and redirect the model to the appropriate tool. Full output is written to a session artifact; truncated output shown inline.

**Preview/resolve** — `ast_edit` and custom tools push a `PendingAction` before committing. The model calls `resolve(action: "apply" | "discard")` to finalize. Actions form a LIFO stack.

**AST-aware edit** — structural rewrites via ast-grep. Matches AST structure, not text; formatting differences are ignored. Multi-pattern passes, contextual `sel` mode, language-scoped rewrites.

**Notebook** — edit, insert, or delete cells in `.ipynb` files by index, backed by the same IPython kernel.

→ [Bash tool](/bash-tool-runtime) · [Resolve tool](/resolve-tool-runtime) · [Notebook tool](/notebook-tool-runtime) · [Custom tools](/custom-tools)

### Slash commands

Discovered from four providers (`native` → `claude` → `claude-plugins` → `codex`) with priority-ordered deduplication. Commands from higher-priority providers shadow same-named commands from lower ones. Extensions register additional commands at load time.

Built-in commands include `/tree`, `/branch`, `/handoff`, `/new`, `/fork`, `/resume`, `/continue`, `/model`, `/mcp`, `/memory`, `/marketplace`, `/settings`, `/skill:<name>`, `/export`, `/clear`, `/help`.

→ [Slash command internals](/slash-command-internals)

### Configuration

Settings merge across four levels: built-ins → user (`~/.pisces/config.json`) → project (`.pisces/config.json`) → env vars. Config roots scanned in order: `.pisces`, `.claude`, `.codex`, `.gemini`. Project settings gated by `enableProjectConfig`.

→ [Configuration](/config-usage) · [Environment variables](/environment-variables) · [Secrets](/secrets)

### Models & providers

Built-in support for Anthropic (Claude), Google (Gemini), Amazon (Bedrock), OpenAI-compatible endpoints, Azure OpenAI, Groq, Cerebras, xAI, OpenRouter, Kilo, Mistral, z.ai. Provider-level `baseUrl`, `apiKey`, `headers`, and `modelOverrides` are configurable in `models.yml`. `thinkingLevel` controls extended thinking budget per agent. Model roles (`initial`, `smol`, `slow`) separate heavy and lightweight model assignments.

→ [Models](/models)

### LSP integration

11 operations: `diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `code_actions`, `type_definition`, `implementation`, `status`, `reload`. 40+ language server configurations built in. Format-on-write via `code_actions`. Disable per-session with `--no-lsp`.

---

## oh-my-pi platform packages

### `@oh-my-pi/pi-ai` — multi-provider streaming

Unified `AssistantMessageEvent` stream across all providers. Every provider normalises to the same event sequence: `start` → content block triplets (`text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`) → terminal `done` or `error`. Delta events are throttled (~50ms batches) before delivery to consumers — TUI and event subscribers see smooth updates regardless of provider stream frequency.

Extended thinking (Anthropic) and structured output (OpenAI responses API) are handled at the provider layer and exposed as first-class events.

→ [Provider streaming internals](/provider-streaming-internals)

### `@oh-my-pi/pi-tui` — differential terminal renderer

Custom terminal UI engine with differential rendering (only changed lines are redrawn), PTY overlays, inline image display (Kitty/iTerm2 protocols), focus management, and cursor marker-based hardware cursor placement. Components implement a simple `render(width): string[]` / `handleInput(data)` contract with no framework dependency.

Theme system drives all color tokens, markdown styling, syntax highlighting palettes, and symbol presets (unicode/nerd/ascii) from a single validated JSON config.

→ [TUI](/tui) · [TUI runtime internals](/tui-runtime-internals) · [Theme](/theme)

### `@oh-my-pi/pi-natives` — Rust N-API core

All performance-critical primitives in a single Rust N-API module. No shelling out.

| Capability | Implementation |
|---|---|
| `grep` | Regex search with `.gitignore`, match streaming, context lines |
| `glob` | Recursive glob with shared FS scan cache |
| `fuzzyFind` | `fd`-style fuzzy file finder |
| `pty` | Full PTY — resize, signal, raw/cooked mode |
| `shell` | Subprocess with merged stdout/stderr, cancellation, timeout |
| `highlight` | Syntax highlighting to ANSI escape sequences |
| `text` | `wrapAnsi`, `truncateToWidth`, `sliceWithWidth` — ANSI-aware |
| `image` | Decode/encode, screenshot HTML→PNG |
| `clipboard` | Read/write system clipboard |

The FS scan cache (`fs_cache`) is shared across `grep` and `glob`. Directory entries are cached on first read and invalidated when the agent writes to that subtree — subsequent calls skip `readdir` for unchanged directories.

→ [Natives architecture](/natives-architecture) · [Text/search pipeline](/natives-text-search-pipeline) · [Shell/PTY](/natives-shell-pty-process)

### `@oh-my-pi/pi-agent` — agent loop

The core turn loop: build context → call LLM → process tool calls → repeat. Handles tool dispatch, parallel tool execution, result collection, and turn-level abort. Emits typed events (`message_update`, `tool_call`, `tool_result`, `turn_end`, `agent_end`) that `AgentSession` consumes for persistence, TTSR, compaction, and extension hooks.

### `@oh-my-pi/pi-sdk` (AI SDK layer)

Lowest-level provider abstraction. `streamSimple()` maps generic options to the correct provider stream function and returns an `AssistantMessageEventStream`. Handles authentication, base URL overrides, and provider-specific header injection.

---

## Configuration discovery across ecosystems

pisces reads capability items (skills, extensions, hooks, tools, MCP servers, slash commands, context files) from **five** config root ecosystems in priority order:

| Priority | Root | Source |
|---|---|---|
| 100 | `~/.pisces/agent/`, `.pisces/` | native |
| 80 | `~/.claude/`, `.claude/` | claude |
| 70 | `~/.codex/`, `.codex/` | codex |
| 70 | `~/.gemini/`, `.gemini/` | gemini |
| 60 | plugins directory | claude-plugins |

This means any skill, hook, extension, or MCP server installed for Claude Code or Codex is automatically available in pisces at the appropriate priority level. pisces-native config always wins on name collisions.
