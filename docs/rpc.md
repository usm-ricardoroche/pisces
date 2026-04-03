# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`) and extension UI responses
- **stdout**: command responses (`RpcResponse`), session/agent events, extension UI requests

Primary implementation:

- `src/modes/rpc/rpc-mode.ts`
- `src/modes/rpc/rpc-types.ts`
- `src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
pisces --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).
- When stdin closes, the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Each frame is a single JSON object followed by `\n`.

There is no envelope beyond the object shape itself.

### Outbound frame categories (stdout)

1. `RpcResponse` (`{ type: "response", ... }`)
2. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
3. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
4. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### State

- `{ id?, type: "get_state" }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`

### Messages

- `{ id?, type: "get_messages" }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0
}
```

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

Extension runner errors are emitted separately as:

```json
{ "type": "extension_error", "extensionPath": "...", "event": "...", "error": "..." }
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- final completion is observed via `agent_end`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`

Example:

```json
{ "type": "extension_ui_request", "id": "123", "method": "confirm", "title": "Confirm", "message": "Continue?", "timeout": 30000 }
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{ "id": "req_2", "type": "response", "command": "set_model", "success": false, "error": "Model not found: provider/model" }
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{ "id": "req_2", "type": "prompt", "message": "Also include risks", "streamingBehavior": "followUp" }
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{ "type": "extension_ui_request", "id": "ui_7", "method": "input", "title": "Branch name", "placeholder": "feature/..." }
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Task Tool: Isolated Execution and Verification

The `task` built-in tool accepts an optional `verify` parameter when `isolated: true` is set.
This parameter enables post-execution verification of the subagent's changes before the patch
or branch is surfaced to the caller.

### `verify` parameter shapes

```typescript
// Disable explicitly (also the default when omitted)
verify: false

// Use the named profile from task.verification.profiles
verify: true          // uses task.verification.defaultProfile
verify: "ci"          // uses the "ci" profile

// Fully inline — no profile lookup required
verify: {
  commands: [
    { name: "typecheck", command: "bun check:ts", timeoutMs: 120000 },
    { name: "tests",     command: "bun test",     timeoutMs: 300000, optional: true }
  ],
  onFailure: "return_failure"   // or "discard_patch"
}

// Profile base + inline override
verify: {
  profile: "ci",
  commands: [{ name: "extra", command: "bun lint" }]
}
```

Verification only runs after a **successful subagent exit** (`exitCode === 0`) in an isolated task.
If the subagent itself fails, verification is recorded as `skipped`.

### `VerificationResult` in `SingleResult`

```typescript
interface VerificationResult {
  requested: boolean;
  profile?:  string;
  mode?:     "none" | "command";
  status:    "not_requested" | "passed" | "failed" | "skipped";
  attempts:  VerificationAttemptResult[];
  retriesUsed: number;
  onFailure?: "return_failure" | "retry_once" | "discard_patch";
}

interface VerificationAttemptResult {
  attempt:        number;
  status:         "passed" | "failed" | "skipped";
  startedAt:      number;   // epoch ms
  endedAt:        number;
  commandResults: VerificationCommandResult[];
  error?:         string;
}

interface VerificationCommandResult {
  name:          string;
  command:       string;
  exitCode:      number;
  durationMs:    number;
  optional?:     boolean;
  timedOut?:     boolean;
  artifactPath?: string;    // written to the task artifacts directory
  outputPreview?: string;   // last ~20 lines / 4 KB of combined stdout+stderr
}
```

### Behaviour on failure

| `onFailure` | Patch captured? | `exitCode` in result |
| --- | --- | --- |
| `return_failure` (default) | yes, patch included | `1` |
| `discard_patch` | no | `1` |

### Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `task.verification.enabled` | boolean | `false` | Master switch for verification features |
| `task.verification.defaultProfile` | string | `""` | Profile used when `verify: true` or `verify: ""` |
| `task.verification.requireForIsolated` | boolean | `false` | Auto-require verification on every isolated task |
| `task.verification.maxRetries` | number | `1` | Global default for bounded repair retries |
| `task.verification.failureContextLineLimit` | number | `200` | Lines preserved in repair context |
| `task.verification.profiles` | record | `{}` | Named profile objects (`TaskVerifyConfig`) |

### Profile configuration example (`omp.jsonc`)

```jsonc
{
  "task.verification.enabled": true,
  "task.verification.defaultProfile": "ci",
  "task.verification.profiles": {
    "ci": {
      "mode": "command",
      "commands": [
        { "name": "typecheck", "command": "bun check:ts", "timeoutMs": 120000 },
        { "name": "lint",      "command": "bun lint:ts",  "timeoutMs": 60000 }
      ],
      "onFailure": "return_failure"
    }
  }
}
```




## Subagent Lifecycle Events

When a task tool dispatches subagents, it emits structured lifecycle events through the same RPC event stream.
These events are visible to SDK subscribers and RPC consumers without any additional setup.

### `subagent_start`

Emitted immediately before a subagent subprocess is started.

```ts
{ type: "subagent_start"; id: string; agent: string; isolated: boolean }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Task item ID (stable across retries) |
| `agent` | string | Agent name |
| `isolated` | boolean | Whether running in an isolated worktree |

### `subagent_end`

Emitted after a subagent subprocess finishes and its verification result (if any) is fully resolved.

```ts
{ type: "subagent_end"; id: string; agent: string; exitCode: number; verification?: VerificationResult }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Task item ID |
| `agent` | string | Agent name |
| `exitCode` | number | Subprocess exit code |
| `verification` | `VerificationResult \| undefined` | Attached if verification was requested |

### `subagent_verification_start`

Emitted before the first command of a verification attempt runs.

```ts
{ type: "subagent_verification_start"; id: string; attempt: number; profile?: string }
```

### `subagent_verification_command_start`

Emitted just before each individual verification command spawns.

```ts
{ type: "subagent_verification_command_start"; id: string; attempt: number; commandName: string }
```

### `subagent_verification_command_end`

Emitted after each verification command exits.

```ts
{
  type: "subagent_verification_command_end";
  id: string;
  attempt: number;
  commandName: string;
  exitCode: number;
  durationMs: number;
  artifactId?: string;  // artifact path when command produced output
}
```

### `subagent_verification_end`

Emitted after all commands in a verification attempt have run.

```ts
{ type: "subagent_verification_end"; id: string; attempt: number; status: "passed" | "failed" | "skipped" | "budget_exceeded" }
```

All six event types appear in the `AgentSessionEvent` union and are forwarded through the existing RPC stream.
No new transport or subscription channel is needed.

## Notes on `RpcClient` helper

`src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches only recognized `AgentEvent` types to listeners
- Does **not** expose helper methods for every protocol command (for example, `set_interrupt_mode` and `set_session_name` are in protocol types but not wrapped as dedicated methods)

Use raw protocol frames if you need complete surface coverage.