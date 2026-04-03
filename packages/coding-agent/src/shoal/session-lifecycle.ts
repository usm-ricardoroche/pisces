/**
 * ShoalMcpBridge — primary Shoal integration contract for Pisces.
 *
 * This is the only approved way to call Shoal MCP tools from Pisces.
 * All new Shoal functionality (message envelopes, action requests, etc.)
 * must be added here, not scattered across unrelated modules.
 * See PISCES_SHOAL_EXECUTION_MODEL.md for the full integration boundary.
 *
 * Spawns `shoal-mcp-server` as a stdio subprocess (the FastMCP server defined
 * in `shoal.services.mcp_shoal_server`) and exposes each orchestration-relevant
 * tool as a typed async method.
 *
 * Implemented Shoal contract surfaces:
 *   P0 — enriched send/receive, action bus (request/approve/deny/list)
 *   P1 — watch_session_messages, get_workflow_messages, watch_session_actions,
 *          session_summary.active_workflow_ids
 *
 * Usage:
 *   const bridge = new ShoalMcpBridge();
 *   await bridge.connect();
 *   const session = await bridge.createSession({ name: "auth-planner", template: "pisces-planner", ... });
 *   await bridge.disconnect();
 */

import { callTool, connectToServer } from "../mcp/client";
import type { MCPServerConnection, MCPToolCallResult } from "../mcp/types";

// ── Error type ───────────────────────────────────────────────────────────────

export class ShoalBridgeError extends Error {
	constructor(
		message: string,
		readonly tool: string,
	) {
		super(message);
		this.name = "ShoalBridgeError";
	}
}

// ── Message types ────────────────────────────────────────────────────────────

export type MessageKind =
	| "event"
	| "request"
	| "response"
	| "handoff"
	| "system"
	| "approval_request"
	| "approval_response";

export interface SendMessageOptions {
	kind?: MessageKind;
	correlationId?: string;
	replyToMessageId?: number | null;
	priority?: number;
	requiresAck?: boolean;
	metadata?: Record<string, unknown>;
}

/** Raw message object returned by Shoal MCP (snake_case from Python). */
export interface MessageObject {
	id: number;
	to: string;
	topic: string;
	kind: MessageKind;
	payload: string;
	from_session: string;
	correlation_id: string | null;
	reply_to_message_id: number | null;
	priority: number;
	acked_at: string | null;
	created_at: string;
}

export interface WatchMessagesParams {
	session: string;
	topic?: string;
	kind?: MessageKind;
	correlationId?: string;
	afterId?: number;
	timeoutSeconds?: number;
}

export interface GetWorkflowMessagesParams {
	correlationId: string;
	kind?: MessageKind;
	limit?: number;
	afterId?: number;
}

// ── Action types ─────────────────────────────────────────────────────────────

/** Raw SessionAction object returned by Shoal MCP (snake_case from Python). */
export interface SessionActionObject {
	id: number;
	requester_session: string;
	target_session: string | null;
	target_role: string | null;
	action_type: string;
	payload: Record<string, unknown>;
	correlation_id: string | null;
	status: string;
	resolved_by: string | null;
	created_at: string;
}

export interface WatchActionsParams {
	targetSession?: string;
	targetRole?: string;
	correlationId?: string;
	timeoutSeconds?: number;
}

export interface RequestActionParams {
	requesterSession: string;
	actionType: string;
	payloadJson: string;
	targetSession?: string;
	targetRole?: string;
	correlationId?: string;
	metadataJson?: string;
}

export interface ListPendingActionsParams {
	targetSession?: string;
	targetRole?: string;
	correlationId?: string;
	limit?: number;
}

// ── Session summary types ─────────────────────────────────────────────────────

export interface SessionSummaryResult {
	summary: string | null;
	/** Sorted distinct correlation_id values from unconsumed inbox messages. */
	activeWorkflowIds: string[];
}

// ── Param / result types ─────────────────────────────────────────────────────

export interface CreateSessionParams {
	name: string;
	path?: string;
	template: string;
	worktree?: string;
	branch?: boolean;
	mcpServers?: string[];
	prompt?: string;
}

export interface SessionResult {
	id: string;
	name: string;
	tool: string;
	status: string;
	branch: string;
	worktree: string;
}

export interface SessionSnapshotEntry {
	name: string;
	status?: string;
	pane?: string;
	branch?: string;
	worktree?: string;
	completedAt?: string | null;
}

export interface SessionSnapshotResult {
	sessions: SessionSnapshotEntry[];
}

export interface CompletionResult {
	completed: boolean;
	completedAt?: string;
	waitedSeconds: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(result: MCPToolCallResult): string {
	if (result.isError) {
		const msg = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: "text"; text: string }).text)
			.join("\n");
		throw new Error(msg || "Shoal MCP tool returned an error");
	}
	return result.content
		.filter(c => c.type === "text")
		.map(c => (c as { type: "text"; text: string }).text)
		.join("\n");
}

function parseJson(result: MCPToolCallResult): unknown {
	const text = extractText(result);
	try {
		return JSON.parse(text);
	} catch {
		// FastMCP sometimes returns the result as a JSON literal that the MCP
		// layer wraps in a text content node; return as-is to let callers handle.
		return text;
	}
}

// ── Bridge class ─────────────────────────────────────────────────────────────

export class ShoalMcpBridge {
	#connection: MCPServerConnection | null = null;
	#signal?: AbortSignal;

	constructor(signal?: AbortSignal) {
		this.#signal = signal;
	}

	async connect(): Promise<void> {
		if (this.#connection) return;
		this.#connection = await connectToServer(
			"shoal",
			{
				type: "stdio",
				command: "shoal-mcp-server",
				args: [],
			},
			{ signal: this.#signal },
		);
	}

	async disconnect(): Promise<void> {
		if (!this.#connection) return;
		await this.#connection.transport.close();
		this.#connection = null;
	}

	#conn(): MCPServerConnection {
		if (!this.#connection) throw new Error("ShoalMcpBridge: not connected — call connect() first");
		return this.#connection;
	}

	async #call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			const result = await callTool(this.#conn(), toolName, args, { signal: this.#signal });
			return parseJson(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new ShoalBridgeError(msg, toolName);
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	async createSession(params: CreateSessionParams): Promise<SessionResult> {
		const args: Record<string, unknown> = {
			name: params.name,
			template: params.template,
		};
		if (params.path) args.path = params.path;
		if (params.worktree) args.worktree = params.worktree;
		if (params.branch) args.branch = params.branch;
		if (params.prompt) args.prompt = params.prompt;
		// Always include shoal-orchestrator so workers can call mark_complete,
		// send_session_message, etc. Merged server-side with template's mcp list.
		args.mcp_servers = Array.from(new Set(["shoal-orchestrator", ...(params.mcpServers ?? [])]));

		return this.#call("create_session", args) as Promise<SessionResult>;
	}

	async killSession(session: string, opts?: { removeWorktree?: boolean; force?: boolean }): Promise<void> {
		await this.#call("kill_session", {
			session,
			remove_worktree: opts?.removeWorktree ?? false,
			force: opts?.force ?? false,
		});
	}

	// ── Observation ──────────────────────────────────────────────────────────

	async sessionSnapshot(sessions: string[], fields?: string[], paneLines = 50): Promise<SessionSnapshotResult> {
		const args: Record<string, unknown> = { sessions, pane_lines: paneLines };
		if (fields?.length) args.fields = fields;
		return this.#call("session_snapshot", args) as Promise<SessionSnapshotResult>;
	}

	async waitForCompletion(session: string, timeoutSeconds = 600): Promise<CompletionResult> {
		return this.#call("wait_for_completion", {
			session,
			timeout_seconds: timeoutSeconds,
		}) as Promise<CompletionResult>;
	}

	async sessionSummary(session: string): Promise<SessionSummaryResult> {
		const result = (await this.#call("session_summary", { session })) as {
			summary: string | null;
			active_workflow_ids?: string[];
		};
		return {
			summary: result.summary,
			activeWorkflowIds: result.active_workflow_ids ?? [],
		};
	}

	// ── Worktree access ──────────────────────────────────────────────────────

	async readWorktreeFile(session: string, path: string, maxLines = 200): Promise<string> {
		const result = (await this.#call("read_worktree_file", {
			session,
			path,
			max_lines: maxLines,
		})) as { content: string };
		return result.content;
	}

	async listWorktreeFiles(session: string, glob = "*"): Promise<string[]> {
		const result = (await this.#call("list_worktree_files", {
			session,
			glob_pattern: glob,
		})) as { files: string[] };
		return result.files;
	}

	// ── Git ──────────────────────────────────────────────────────────────────

	async mergeBranch(session: string, target: string, strategy: "merge" | "squash" = "merge"): Promise<void> {
		await this.#call("merge_branch", { session, target, strategy });
	}

	async branchStatus(session: string): Promise<{
		branch: string;
		ahead: number;
		behind: number;
		dirty: boolean;
		lastCommit: string;
	}> {
		return this.#call("branch_status", { session }) as Promise<{
			branch: string;
			ahead: number;
			behind: number;
			dirty: boolean;
			lastCommit: string;
		}>;
	}

	// ── Journal ──────────────────────────────────────────────────────────────

	async appendJournal(session: string, entry: string, source = "orchestrator"): Promise<void> {
		await this.#call("append_journal", { session, entry, source });
	}

	// ── Agent Bus ────────────────────────────────────────────────────────────

	async sendMessage(
		to: string,
		topic: string,
		payload: string,
		from = "",
		opts?: SendMessageOptions,
	): Promise<number> {
		const args: Record<string, unknown> = { to, topic, payload, from_session: from };
		if (opts?.kind) args.kind = opts.kind;
		if (opts?.correlationId) args.correlation_id = opts.correlationId;
		if (opts?.replyToMessageId != null) args.reply_to_message_id = opts.replyToMessageId;
		if (opts?.priority != null) args.priority = opts.priority;
		if (opts?.requiresAck != null) args.requires_ack = opts.requiresAck;
		if (opts?.metadata) args.metadata = opts.metadata;
		const result = (await this.#call("send_session_message", args)) as { id: number };
		return result.id;
	}

	async watchMessages(params: WatchMessagesParams): Promise<MessageObject[]> {
		const args: Record<string, unknown> = { session: params.session };
		if (params.topic) args.topic = params.topic;
		if (params.kind) args.kind = params.kind;
		if (params.correlationId) args.correlation_id = params.correlationId;
		if (params.afterId != null) args.after_id = params.afterId;
		if (params.timeoutSeconds != null) args.timeout_seconds = params.timeoutSeconds;
		return (await this.#call("watch_session_messages", args)) as MessageObject[];
	}

	async getWorkflowMessages(params: GetWorkflowMessagesParams): Promise<MessageObject[]> {
		const args: Record<string, unknown> = { correlation_id: params.correlationId };
		if (params.kind) args.kind = params.kind;
		if (params.limit != null) args.limit = params.limit;
		if (params.afterId != null) args.after_id = params.afterId;
		return (await this.#call("get_workflow_messages", args)) as MessageObject[];
	}

	async watchActions(params: WatchActionsParams): Promise<SessionActionObject[]> {
		const args: Record<string, unknown> = {};
		if (params.targetSession) args.target_session = params.targetSession;
		if (params.targetRole) args.target_role = params.targetRole;
		if (params.correlationId) args.correlation_id = params.correlationId;
		if (params.timeoutSeconds != null) args.timeout_seconds = params.timeoutSeconds;
		return (await this.#call("watch_session_actions", args)) as SessionActionObject[];
	}

	async ackMessage(messageId: number): Promise<void> {
		await this.#call("mark_session_message_acked", { message_id: messageId });
	}

	// ── Lists ────────────────────────────────────────────────────────────────

	async listSessions(
		path?: string,
	): Promise<
		{ id: string; name: string; status: string; tool: string; worktree: string; path: string; branch: string }[]
	> {
		const args = path ? { path } : {};
		return this.#call("list_sessions", args) as Promise<
			{ id: string; name: string; status: string; tool: string; worktree: string; path: string; branch: string }[]
		>;
	}

	// ── Action bus ───────────────────────────────────────────────────────────

	async requestAction(
		params: RequestActionParams,
	): Promise<{ id: number; action_type: string; status: string; correlation_id: string | null }> {
		const args: Record<string, unknown> = {
			requester_session: params.requesterSession,
			action_type: params.actionType,
			payload_json: params.payloadJson,
		};
		if (params.targetSession) args.target_session = params.targetSession;
		if (params.targetRole) args.target_role = params.targetRole;
		if (params.correlationId) args.correlation_id = params.correlationId;
		if (params.metadataJson) args.metadata_json = params.metadataJson;
		return this.#call("request_session_action", args) as Promise<{
			id: number;
			action_type: string;
			status: string;
			correlation_id: string | null;
		}>;
	}

	async listPendingActions(params: ListPendingActionsParams = {}): Promise<SessionActionObject[]> {
		const args: Record<string, unknown> = {};
		if (params.targetSession) args.target_session = params.targetSession;
		if (params.targetRole) args.target_role = params.targetRole;
		if (params.correlationId) args.correlation_id = params.correlationId;
		if (params.limit) args.limit = params.limit;
		return this.#call("list_pending_session_actions", args) as Promise<SessionActionObject[]>;
	}

	async approveAction(actionId: number, resolvedBy: string, reason?: string): Promise<SessionActionObject> {
		const args: Record<string, unknown> = { action_id: actionId, resolved_by: resolvedBy };
		if (reason) args.reason = reason;
		return this.#call("approve_session_action", args) as Promise<SessionActionObject>;
	}

	async denyAction(actionId: number, resolvedBy: string, reason?: string): Promise<SessionActionObject> {
		const args: Record<string, unknown> = { action_id: actionId, resolved_by: resolvedBy };
		if (reason) args.reason = reason;
		return this.#call("deny_session_action", args) as Promise<SessionActionObject>;
	}
}
