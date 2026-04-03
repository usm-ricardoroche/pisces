# Pisces — Shoal Execution Model

## Purpose

This document defines how Pisces uses parallelism and when to involve Shoal.
It is the Phase 0 deliverable of the Pisces-Shoal migration plan.

## Two parallelism modes

Pisces has two distinct ways to decompose work across multiple agents.
They are not interchangeable.

### Mode 1: `task` — in-session subagents

The `task` tool spawns subagents inside the current runtime session.
Subagents share the parent session's process, worktree, and memory.

Use `task` when:

- delegation stays inside one runtime session
- separate worktrees are not needed
- workers do not need long-lived session identity
- outputs stay local to the parent session
- work is short-lived (planning, analysis, parallel exploration)

`task` is always available. It does not require Shoal.

### Mode 2: `/team` — Shoal-backed multi-session execution

`/team run <file.yaml>` creates one Shoal session per agent.
Each session gets its own tmux pane, optional git worktree, and independent
context. The `ShoalOrchestrator` drives wave-based execution and polls
completion via `ShoalMcpBridge`.

Use `/team` (Shoal-backed) when:

- agents need separate git worktrees
- sessions should be independently inspectable
- the run needs fleet-level status and supervision
- durable handoffs or journals are required
- cross-session messaging or future approval flows are needed
- the run is long-lived enough to warrant session identity

`/team` requires `shoal-mcp-server` on PATH and `shoal.enabled: true`
(the default). If Shoal is not installed, the command fails with a clear
error at connect time — it does not silently fall back to `task`.

## Decision rule

> If the work fits inside one agent session, use `task`.
> If the work needs multiple long-lived isolated workers, use `/team`.

Neither mode replaces the other. They occupy different scopes.

## Shoal's role in Pisces

Shoal is Pisces' inter-session execution substrate. Pisces delegates to Shoal
for everything that crosses session boundaries:

- creating and killing worker sessions
- managing git worktrees
- waiting for completion (`wait_for_completion`)
- reading session state (`session_snapshot`)
- exchanging inter-session messages (Agent Bus)
- durable handoff state (journals)
- action/approval flows (`requestAction` / `approveAction` / `denyAction`)

Pisces does not reimplement any of these. It calls Shoal through the stable
integration seam described below.

Pisces retains full ownership of:

- agent runtime behavior
- prompts and system behavior
- model/tool selection policy
- task/subagent decomposition heuristics
- deciding when to use `task` versus `/team`
- agent personas and template definitions

## Integration boundary

All Shoal interactions in Pisces are centralized in
`packages/coding-agent/src/shoal/`. No code outside this package should
call Shoal MCP tools directly or read Shoal internals.

The boundary modules are:

| Module | Role |
|---|---|
| `session-lifecycle.ts` | Primary Shoal integration contract. `ShoalMcpBridge` wraps every Shoal MCP tool Pisces uses. |
| `orchestrator.ts` | Wave-based multi-agent execution engine. Uses `ShoalMcpBridge` exclusively for correctness-critical operations. |
| `commands.ts` | `/team` slash command and LLM tools. User-facing entry point. |
| `awareness.ts` | Best-effort context injection. Calls `ShoalMcpBridge.listSessions(cwd)` with server-side path filtering. Silent-degrades if MCP server is absent. |
| `expertise.ts` | Post-session expertise fin trigger. Fire-and-forget subprocess call to `shoal fin run`. |
| `team-schema.ts` | YAML parsing and DAG utilities. No Shoal dependency. |

## `awareness.ts` context injection

`awareness.ts` calls `list_sessions` via `ShoalMcpBridge`, passing `cwd` as a server-side
path filter (Shoal resolves git root and worktree prefix server-side). A fresh bridge connection is
opened and closed per hook invocation (connect → query → disconnect). Any error
silently returns an empty result — orchestration is unaffected.

It must not be used for:

- orchestration correctness
- task completion decisions
- worker targeting
- approval logic


### Rule: no direct Shoal SQLite reads

`bun:sqlite` must not be imported in any Pisces shoal module.
All Shoal data flows through `ShoalMcpBridge`.

## Boundary rules

### Rule 1: `task` and `/team` are different scopes

Do not mix them. `task` is intra-session. `/team` is inter-session.
Do not add session-lifecycle logic inside the `task` runtime.
Do not add worktree or session assumptions inside in-process subagents.

### Rule 2: Shoal is a substrate, not a bag of internals

Pisces depends on Shoal behavior, not Shoal implementation details.
Never add new direct reads of Shoal SQLite schema from any Pisces module.
Never add new direct tmux calls from Pisces.
All new Shoal functionality flows through `ShoalMcpBridge`.

### Rule 3: Awareness may degrade, orchestration may not

If `awareness.ts` fails silently:
- system prompt context may be less rich
- orchestration through `ShoalOrchestrator` must still work

## Correlation and message envelopes (implemented)

Every `/team` run now has a stable workflow identity: `correlationId` is generated
at `ShoalOrchestrator.run()` start (format: `wf_<16-hex-chars>`), threaded through
`OrchestrationProgress`, surfaced in the live TUI widget and completion notifications,
and returned in `OrchestrationResult`.

`ShoalMcpBridge.sendMessage` accepts a full `SendMessageOptions` bag:
`kind`, `correlationId`, `replyToMessageId`, `priority`, `requiresAck`, `metadata`.

New bridge methods (P1 + Phase 5):
- `watchMessages(params)` — block until matching messages arrive or timeout
- `getWorkflowMessages(params)` — cross-session trace by `correlationId`
- `watchActions(params)` — block until pending actions match filters
- `ackMessage(messageId)` — mark a message consumed
- `sessionSummary` now returns `{ summary, activeWorkflowIds }` (P1 enrichment)
- `requestAction(params)` — worker submits an action request to the action bus
- `listPendingActions(params)` — poll unresolved requests by `correlationId`
- `approveAction(id, resolvedBy, reason?)` — human approves via `/team approve`
- `denyAction(id, resolvedBy, reason?)` — human denies via `/team deny`

Action gating (Phase 5, implemented):
- `ShoalOrchestrator` calls `listPendingActions` after each wave; any pending
  request halts the next wave and polls until cleared or the run is aborted.
- The TUI widget lists each pending action with its ID, type, requester, and the
  exact `/team approve <id>` or `/team deny <id>` command to resolve it.
- Workers may call the `shoal_request_action` LLM tool to submit any action type
  before performing a destructive or privileged operation.
- Humans resolve via `/team approve <id> [reason]` or `/team deny <id> [reason]`
  in the Pisces session.

All changes confined to `session-lifecycle.ts`, `orchestrator.ts`, and `commands.ts`.
No new direct Shoal dependencies added elsewhere.