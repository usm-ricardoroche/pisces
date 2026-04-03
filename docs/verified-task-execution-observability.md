# Verified task execution and observability/budget architecture

This document defines the first platform-hardening tranche after lobster-party integration.

Roadmap alignment:
- Epic 1: verified isolated task execution
- Epic 2: standard telemetry bridge
- Epic 3: budget policy and enforcement

Although the roadmap tracks budget enforcement separately, this design covers Epics 2 and 3 together because budget enforcement depends on the same usage and event plumbing as telemetry.

## Why this is the next tranche

Pisces already has the core primitives:
- isolated subagent execution with worktree/overlay modes
- structured task results and patch outputs
- RPC/SDK event streaming from `AgentSession`
- local usage and cost persistence in `@oh-my-pi/omp-stats`
- existing retry machinery for provider failures

What Pisces does not yet have is a platform-grade contract for:
- proving an isolated patch was checked before it is surfaced as "done"
- showing embedders exactly what happened during task execution
- enforcing hard spend/time/tool budgets on delegated work

The goal of this tranche is to move Pisces from "powerful runtime" to "embedder-grade agent platform" without changing the existing mental model of tasks, sessions, or RPC.

## Goals

### Epic 1 — verified isolated task execution
- Add first-class verification policies to isolated `task` runs.
- Run verification inside the isolated workspace before merge/apply.
- Persist verification logs as artifacts.
- Surface verification status in task results, RPC events, SDK events, and telemetry.
- Support one bounded auto-correction retry using verification failure context.

### Epic 2 — standard telemetry bridge
- Convert existing runtime/session/task signals into OpenTelemetry-compatible spans.
- Expose subagent, tool, model, retry, compaction, and verification behavior to embedders.
- Add `gen_ai_tool_definitions` to model-call spans so available tools are visible in traces.
- Preserve the current event model; do not invent a second runtime.

### Epic 3 — budget policy and enforcement
- Add hard budgets for wall time, tokens, spend, tool calls, and subagent fanout.
- Surface budget burn and budget-exceeded reasons through RPC/SDK/stats.
- Enforce budgets at safe boundaries instead of using opaque background heuristics.

## Non-goals

- Full repo semantic retrieval or vector indexing.
- Session replay UI implementation.
- Screenshot-to-code workflow.
- Project-wide auto-fix loops for every prompt.
- Replacing `@oh-my-pi/omp-stats`; this tranche extends it.

## Existing surfaces this design builds on

### Task runtime
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/task/types.ts`
- `packages/coding-agent/src/task/worktree.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

### Session and event runtime
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/extensibility/extensions/types.ts`
- `packages/coding-agent/src/sdk.ts`
- `docs/rpc.md`

### Usage/cost stats
- `packages/stats/src/db.ts`

### Existing related behavior
- provider failure retries: `docs/non-compaction-retry-policy.md`
- isolated task execution: `docs/task-agent-discovery.md`
- session tree and event stream: `docs/session.md`, `docs/rpc.md`

---

## Epic 1 — verified isolated task execution

## Problem statement

Today, isolated task execution gives Pisces a safe place to produce patches, but there is no first-class guarantee that those patches were checked before being returned.

The current gaps are:
- no verification policy attached to isolated task runs
- no consistent result metadata saying whether a patch is verified or merely produced
- no artifactized verification logs
- no bounded patch-repair retry loop driven by verification output

For embedders, this means the host must build its own policy layer on top of Pisces.

## Design principles

- Verification is explicit, not hidden magic.
- Verification is bounded: retries, time, spend, and log size are capped.
- Verification applies to isolated tasks first; non-isolated verification stays out of scope for v1.
- Failed verification does not silently disappear; it returns structured metadata and artifacts.
- Verification should be explainable to both humans and host applications.

## Verification model

### Scope

V1 supports verification only when `isolated: true` and task isolation mode is not `none`.

If verification is requested on a non-isolated task, Pisces returns a structured error explaining that verification requires isolated execution.

### Verification modes

```ts
export type VerificationMode = "none" | "lsp" | "command" | "profile";

export interface VerificationCommand {
	name: string;
	command: string;
	timeoutMs?: number;
	optional?: boolean;
}

export interface VerificationProfile {
	mode: Exclude<VerificationMode, "profile">;
	lspDiagnostics?: boolean;
	commands?: VerificationCommand[];
	maxRetries?: number;
	timeoutMs?: number;
	failureContextLineLimit?: number;
	onFailure?: "return_failure" | "retry_once" | "discard_patch";
}
```

### Settings schema additions

Proposed settings:
- `task.verification.enabled: boolean`
- `task.verification.defaultProfile: string | undefined`
- `task.verification.requireForIsolated: boolean`
- `task.verification.maxRetries: number`
- `task.verification.failureContextLineLimit: number`
- `task.verification.profiles: Record<string, VerificationProfile>`

Example conceptual config:

```yaml
task:
  verification:
    enabled: true
    defaultProfile: quick
    requireForIsolated: false
    maxRetries: 1
    failureContextLineLimit: 200
    profiles:
      quick:
        mode: command
        commands:
          - name: ts-check
            command: bun check:ts
            timeoutMs: 120000
        onFailure: retry_once
      strict:
        mode: command
        commands:
          - name: ts-check
            command: bun check:ts
          - name: rust-check
            command: bun check:rs
        onFailure: return_failure
```

### Task tool input additions

Add an optional `verify` field to the `task` tool input.

```ts
export type TaskVerifyOption =
	| false
	| true
	| string
	| {
		profile?: string;
		mode?: VerificationMode;
		commands?: VerificationCommand[];
		lspDiagnostics?: boolean;
		maxRetries?: number;
		onFailure?: "return_failure" | "retry_once" | "discard_patch";
	};
```

Semantics:
- `false`: disable verification for this run
- `true`: use default profile
- `"quick"`: use named profile
- object: inline override merged on top of default/profile values

V1 should keep the override surface small and deterministic.

## Result model changes

Extend `SingleResult` in `packages/coding-agent/src/task/types.ts`.

```ts
export interface VerificationAttemptResult {
	attempt: number;
	status: "passed" | "failed" | "skipped" | "budget_exceeded";
	startedAt: number;
	endedAt: number;
	artifactIds?: string[];
	lspDiagnosticsCount?: number;
	commandResults?: Array<{
		name: string;
		exitCode: number;
		durationMs: number;
		artifactId?: string;
		optional?: boolean;
	}>;
	error?: string;
}

export interface VerificationResult {
	requested: boolean;
	profile?: string;
	status:
		| "not_requested"
		| "pending"
		| "running"
		| "passed"
		| "failed"
		| "retried_passed"
		| "budget_exceeded"
		| "skipped";
	attempts: VerificationAttemptResult[];
	retriesUsed: number;
}
```

Add to `SingleResult`:
- `verification?: VerificationResult`

This keeps verification state attached to the exact subagent result instead of burying it in freeform output text.

## Runtime flow

### Baseline flow

1. Parent session dispatches isolated task batch.
2. Task executor creates isolated workspace as today.
3. Subagent runs and produces output/patch.
4. If no patch or no relevant edits were produced, verification may be skipped with explicit status.
5. If verification is enabled:
   - run LSP diagnostics and/or verification commands inside the isolated workspace
   - persist logs as artifacts
   - assemble structured verification result
6. If verification passes:
   - finalize patch metadata
   - allow normal patch/branch return path
7. If verification fails and retries remain:
   - create bounded failure summary
   - inject that summary back into the subagent as explicit repair context
   - rerun verification after the repair turn
8. If verification still fails:
   - return task result with `verification.status = "failed"`
   - keep patch accessible unless policy says `discard_patch`

### Retry behavior

V1 retry policy should be conservative:
- default max retries: `1`
- retry only after a completed verification attempt
- retry only if failure context fits the configured line budget
- retry counts toward wall-time/spend budgets
- do not recursively retry verification commands themselves

### Failure context format

The repair prompt should be static-template based, not hand-built inline.

Inputs:
- command name
- exit code
- truncated stdout/stderr excerpt
- optional summarized diagnostics list
- explicit instruction to repair only the reported failures

The prompt should live in a static `.md` template under the task prompt area, consistent with repo rules.

## Verification commands and artifacts

Each verification command should produce:
- start time
- end time
- exit code
- artifact log path/id when output exceeds inline threshold
- truncated inline excerpt for immediate display

Artifacts should be session-scoped and reused through the existing artifact architecture.

## Event additions

Add task-focused runtime events so SDK/RPC consumers can observe verification without scraping output.

Proposed events:

```ts
interface SubagentStartEvent {
	type: "subagent_start";
	id: string;
	agent: string;
	isolated: boolean;
}

interface SubagentEndEvent {
	type: "subagent_end";
	id: string;
	agent: string;
	exitCode: number;
	verification?: VerificationResult;
}

interface SubagentVerificationStartEvent {
	type: "subagent_verification_start";
	id: string;
	attempt: number;
	profile?: string;
}

interface SubagentVerificationCommandStartEvent {
	type: "subagent_verification_command_start";
	id: string;
	attempt: number;
	commandName: string;
}

interface SubagentVerificationCommandEndEvent {
	type: "subagent_verification_command_end";
	id: string;
	attempt: number;
	commandName: string;
	exitCode: number;
	durationMs: number;
	artifactId?: string;
}

interface SubagentVerificationEndEvent {
	type: "subagent_verification_end";
	id: string;
	attempt: number;
	status: VerificationAttemptResult["status"];
}
```

These should flow through the same subscription model already used by RPC and SDK consumers.

## Merge/apply semantics

V1 policy:
- passing verification marks the result as eligible for merge/apply
- failing verification never silently marks the patch as good
- failed patches remain inspectable unless `onFailure = "discard_patch"`
- branch-mode isolated output may still be returned, but must carry verification metadata

This keeps Pisces transparent and host-friendly.

## File touchpoints

Likely implementation touchpoints:
- `packages/coding-agent/src/task/index.ts`
  - parse `verify` parameter
  - enforce isolated-only behavior in v1
- `packages/coding-agent/src/task/executor.ts`
  - add verification runner
  - add bounded repair retry loop
  - emit subagent verification events
- `packages/coding-agent/src/task/types.ts`
  - extend result types
- `packages/coding-agent/src/config/settings-schema.ts`
  - add verification settings
- `packages/coding-agent/src/prompts/...`
  - add static repair prompt template
- `docs/rpc.md`
  - document new event types and result fields

---

## Epics 2 and 3 — telemetry bridge plus budget enforcement

## Why these are coupled

Telemetry answers "what happened?"
Budget enforcement answers "when must we stop?"

Pisces already tracks parts of usage and cost, but budget enforcement without shared telemetry would duplicate logic and create inconsistent host behavior.

The right architecture is:
1. normalize runtime signals into a common observation stream
2. derive usage/cost/budget state from that stream
3. export spans and budget events from the same source of truth

## Telemetry design

### Architecture

Add a telemetry adapter layer inside coding-agent, not a new top-level runtime.

Conceptually:

```ts
export interface RuntimeTelemetryAdapter {
	onEvent(event: AgentSessionEvent): void;
	onTaskEvent(event: TaskRuntimeEvent): void;
	shutdown(): Promise<void>;
}
```

The default adapter fan-out can include:
- no-op adapter
- OpenTelemetry adapter
- local stats adapter extension hooks if needed later

This keeps instrumentation centralized and avoids scattering exporter-specific code through the runtime.

### Span hierarchy

Recommended span tree:

- `pisces.session`
  - `pisces.turn`
    - `pisces.model_call`
    - `pisces.tool_call`
  - `pisces.auto_retry`
  - `pisces.auto_compaction`
  - `pisces.ttsr_interrupt`
  - `pisces.task_batch`
    - `pisces.subagent_run`
      - `pisces.subagent_verification`
        - `pisces.subagent_verification.command`

### Span attributes

Core attributes:
- `pisces.session.id`
- `pisces.session.file`
- `pisces.turn.index`
- `pisces.agent.name`
- `pisces.model.name`
- `pisces.provider.name`
- `pisces.tool.name`
- `pisces.subagent.id`
- `pisces.isolation.mode`
- `pisces.verification.profile`
- `pisces.verification.status`
- `pisces.retry.count`
- `pisces.ttsr.rules`
- `pisces.artifact.ids`

Usage attributes:
- `gen_ai.request.input_tokens`
- `gen_ai.response.output_tokens`
- `gen_ai.usage.total_tokens`
- `gen_ai.cost.total`

Tool metadata:
- `gen_ai_tool_definitions`

If a provider/tooling layer already exposes richer semantic-convention fields, Pisces should map to those instead of inventing new names.

### Event sources to instrument

Session/runtime events already available:
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_*`
- `tool_execution_*`
- `auto_retry_*`
- `auto_compaction_*`
- `ttsr_triggered`

New task/runtime events from Epic 1:
- `subagent_*`
- `subagent_verification_*`

Telemetry should subscribe to these instead of duplicating internal control flow.

## Budget controller design

### Policy model

```ts
export interface RunBudgetPolicy {
	maxWallTimeMs?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
	maxToolCalls?: number;
	maxSubagents?: number;
	warnAtRatio?: number;
}
```

Settings additions:
- `task.budget.maxWallTimeMs`
- `task.budget.maxInputTokens`
- `task.budget.maxOutputTokens`
- `task.budget.maxTotalTokens`
- `task.budget.maxCostUsd`
- `task.budget.maxToolCalls`
- `task.budget.maxSubagents`
- `task.budget.warnAtRatio`

Scope order:
1. explicit task/run override
2. agent/profile default
3. global settings default

### Enforcement boundaries

Budgets should be enforced at explicit boundaries:
- before starting a new subagent
- before a new model call
- before a tool call
- before a verification retry
- before merge/apply finalization

This avoids unpredictable mid-step kills.

Exceptions:
- wall-time hard limit may abort active isolated work if the deadline is exceeded
- user-triggered abort still wins immediately

### Budget states

```ts
export type BudgetStatus = "ok" | "warning" | "exceeded";

export interface BudgetSnapshot {
	status: BudgetStatus;
	wallTimeMs: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	toolCalls: number;
	subagents: number;
	reason?:
		| "wall_time"
		| "input_tokens"
		| "output_tokens"
		| "total_tokens"
		| "cost"
		| "tool_calls"
		| "subagents";
}
```

### Runtime behavior

- warning threshold default: `0.8`
- on warning: emit event and annotate active span
- on exceed:
  - stop launching new expensive work
  - mark result as budget-exceeded
  - surface structured error/event
  - keep artifacts and partial outputs retrievable

Budget exceed should never masquerade as a generic tool failure.

## Budget events

Proposed additions:

```ts
interface BudgetWarningEvent {
	type: "budget_warning";
	scope: "session" | "task" | "subagent";
	snapshot: BudgetSnapshot;
}

interface BudgetExceededEvent {
	type: "budget_exceeded";
	scope: "session" | "task" | "subagent";
	snapshot: BudgetSnapshot;
}
```

These should appear in SDK subscriptions, RPC event streams, and telemetry.

## Stats persistence changes

`@oh-my-pi/omp-stats` already stores message-level usage and cost. For this tranche, add run-level visibility without losing current tables.

Preferred extension:
- keep `messages` table as-is for provider/message accounting
- add a new `runs` table for task/subagent/verification lifecycle summaries

Suggested `runs` columns:
- `run_id`
- `session_file`
- `parent_run_id`
- `kind` (`session` | `task_batch` | `subagent` | `verification`)
- `agent`
- `started_at`
- `ended_at`
- `duration_ms`
- `status`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `cost_total`
- `tool_calls`
- `artifact_ids_json`
- `budget_reason`

This keeps dashboards able to answer:
- which subagent failed verification most often?
- what is the cost of verification overhead?
- where do budget overruns happen?

## RPC and SDK changes

### RPC

Update `docs/rpc.md` and the wire schema to include:
- `subagent_*` events
- `subagent_verification_*` events
- `budget_warning`
- `budget_exceeded`

No new transport is required.

### SDK

The existing subscription API should carry the new events automatically once the event union is extended.

Optional future convenience:
- typed helper subscriptions for verification and budget events

---

## Rollout plan

### Phase 1 — verification metadata and events
- add verification settings and task input overrides
- extend task result types
- emit verification lifecycle events
- artifactize command logs
- return structured verification status without auto-retry

### Phase 2 — bounded repair retry
- add static repair prompt template
- implement single retry with bounded failure context
- emit retry-related verification events

### Phase 3 — telemetry adapter
- add central telemetry interface
- map session/task events to spans
- decorate model spans with tool definitions

### Phase 4 — budget enforcement
- implement budget snapshots and warning/exceeded events
- enforce boundaries in task/subagent/model/tool transitions
- persist run-level summaries in stats DB

---

## Open questions

- Should failed verification patches be hidden by default in TUI, or only marked as failed?
- Should verification run automatically for all isolated tasks when `task.verification.requireForIsolated = true`, even if the caller did not request it?
- Should budget policies be session-wide only, or can each subagent in a task batch carry its own override?
- Do we want a separate typed task-runtime event union, or should task events be folded into `AgentSessionEvent` directly?

## Recommendation

Implementation order:
1. verification metadata and lifecycle events
2. command/LSP verification runner in isolated workspaces
3. bounded repair retry
4. telemetry adapter and OTel exporter
5. budget controller and enforcement
6. stats DB run-level summaries

That sequence delivers visible user value early while keeping the deeper instrumentation work on the same eventual architecture.