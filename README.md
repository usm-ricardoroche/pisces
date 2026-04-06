<p align="center">
  <img src="https://usm-ricardoroche.github.io/pisces/hero-dark.png" alt="pisces">
</p>

<p align="center">
  <strong>pisces — AI coding agent for headless and server use</strong>
</p>

<p align="center">
  <a href="https://usm-ricardoroche.github.io/pisces/">Docs</a> ·
  <a href="https://github.com/usm-ricardoroche/pisces">GitHub</a> ·
  <a href="https://github.com/can1357/oh-my-pi">Upstream</a>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/can1357/oh-my-pi">can1357/oh-my-pi</a> targeting first-class headless/server use.<br>
  Primary integration target: <a href="https://github.com/usm-ricardoroche/lobster-party">lobster-party</a>.<br>
  See <a href="PLAN.md">PLAN.md</a> and <a href="ROADMAP.md">ROADMAP.md</a> for integration status and architecture.
</p>

<blockquote>
<strong>Binary:</strong> <code>pisces</code> (symlink <code>omp</code> for compatibility)<br>
<strong>Upstream:</strong> <a href="https://github.com/can1357/oh-my-pi">can1357/oh-my-pi</a> — sync periodically; changes scoped to <code>src/lobster/</code>, <code>src/shoal/</code>, <code>src/cli/args.ts</code>, <code>src/modes/print-mode.ts</code>, and Epic modules (telemetry, budget enforcement, verified task execution).
</blockquote>

---

## What Pisces is

Pisces is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) purpose-built for headless and server-side embedding. It is the agent runtime used inside [lobster-party](https://github.com/usm-ricardoroche/lobster-party) and the [Shoal](https://github.com/usm-ricardoroche/shoal-cli) orchestration stack at US Mobile.

It is **not** a general-purpose interactive coding agent rebranding. oh-my-pi handles that use case well — use it directly for interactive terminal sessions. Pisces exists because automated pipelines need headless operation, deterministic process lifecycle, structured exit codes, injected MCP pools, and tight integration with majordomo-do and Shoal session orchestration.

---

## Pisces-specific additions

### Lobster-party integration

Set `PISCES_LOBSTER_MODE=1` to activate. Pisces loads `messageUser` and `memorySearch` tools via the extension API and establishes socket communication with the majordomo-do sidecar. The `agent_end` session event carries `sessionId` and `sessionFile` fields required for lobster-loop conversation persistence.

Source: `src/lobster/`

### Shoal `/team` command

Full wave-based multi-agent orchestration from within a session. `/team <task>` fans work out across a coordinated agent pool with action gating, correlation IDs, and a dedicated TUI widget showing live wave progress.

Source: `src/shoal/`; execution model documented in `PISCES_SHOAL_EXECUTION_MODEL.md`.

### Unix socket MCP injection (`PISCES_MCP_SOCKETS`)

Shoal-P1 feature. Set `PISCES_MCP_SOCKETS` (or `pisces.mcpSockets` in settings) to a comma-separated list of Unix socket paths. Pisces connects to each socket as an MCP server at startup, enabling shared MCP pools across a Shoal session without per-agent server spawning.

### Preset system

Set `pisces.preset` in settings or pass `--preset <name>` to apply a named configuration bundle. See [Preset system](#preset-system) below.

### CLI flags added by Pisces

| Flag | Description |
|---|---|
| `--mode=json` | JSON output mode (equals form now works; unrecognised modes error loudly) |
| `--agent <name>` | Select a bundled agent for print mode |
| `--no-provider-discovery` | Disable ambient env-var provider resolution (required in lobster sandboxes) |
| `--session-dir <path>` | Override the session storage directory; wired end-to-end to `SessionManager` |
| `--preset <name>` | Apply a named preset (`lobster`, `headless`, `minimal`) |

### Environment variables added by Pisces

| Variable | Description |
|---|---|
| `PISCES_LOBSTER_MODE` | `1` to activate lobster-party integration (loads extension, opens majordomo-do socket) |
| `PISCES_MAJORDOMO_SOCKET` | Path to the majordomo-do Unix socket |
| `PISCES_RUN_CHANNEL_KEY` | Channel key for the current lobster run |
| `PISCES_MCP_SOCKETS` | Comma-separated Unix socket paths to attach as MCP servers at startup |
| `PISCES_SHOAL_ENABLED` | `1` to enable Shoal orchestration features |

### Preset system

| Preset | Description |
|---|---|
| `lobster` | Full lobster-party integration: lobster mode on, provider discovery off, MCP sockets from env |
| `headless` | Headless server operation: no TUI, JSON output, structured errors |
| `minimal` | Minimal footprint: no provider discovery, no extensions, no ambient config |

### Structured error JSON

On fatal error Pisces exits 1 and writes a JSON object to stdout: `{ code, message }`. Error codes: `INVALID_ARG`, `NO_MODEL`, `STARTUP_ERROR`, `TURN_FAILED`. Implemented via `fatalError()` in `src/cli/args.ts`.

### Standard telemetry bridge

OTLP-compatible telemetry via `OtelTelemetryAdapter`. Emits full span hierarchies in OTLP/JSON format. Configured via `pisces.telemetry` settings block.

### Budget policy enforcement

Seven-dimensional budget control enforced by `BudgetController`. Hard limits on token spend, tool calls, wall time, and related dimensions. The task tool enforces budgets before dispatching subagents. Configuration via `pisces.budget`.

### Verified isolated task execution

Verification policies with repair retries, six new event types (`verification.*`), and isolation guarantees for subagent task runs. Documented in [`docs/verified-task-execution-observability.md`](./docs/verified-task-execution-observability.md).

### Session inspect CLI

```
pisces session inspect <file>
```

Replays and analyses a saved session file. Useful for post-mortem debugging of lobster-loop runs.

### Hybrid search tool

Unified `grep + ast_grep + lsp` retrieval tool. Extends the upstream search tool with structured AST matching and LSP symbol resolution in a single tool call.

### `.pisces/` config directory

Pisces reads config from `.pisces/` and `~/.pisces/` first, then falls back to `.claude/`, `.codex/`, and `.gemini/` for cross-tool compatibility.

---

## Upstream features

Everything not listed above is inherited directly from oh-my-pi: TUI, session tree, time-traveling streamed rules (TTSR), parallel subagents, Python IPython kernel, LSP integration, extension model, MCP protocol support, skills, hooks, custom tools, commit tool, web search, browser automation, model roles, and more.

See the [oh-my-pi README](https://github.com/can1357/oh-my-pi#readme) and the [local docs site](https://usm-ricardoroche.github.io/pisces/) for full documentation of inherited features.

---

## Development

Sync upstream changes:

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git
git fetch upstream
git merge upstream/main
```

Pisces changes are intentionally scoped to minimise merge conflicts. New behaviour lives in `src/lobster/`, `src/shoal/`, and the Epic modules; upstream files are patched only where necessary (`src/cli/args.ts`, `src/modes/print-mode.ts`, core session event types).

Type-check:

```sh
bun check:ts
```

---

## License

MIT. Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), which is itself a fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/mariozechner).

