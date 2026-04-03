/**
 * Session inspection types for replay inspector.
 * These types provide structured access to session data for
 * replay, analysis, and visualization.
 */

import type { SessionTreeNode } from "../session-manager";

/** Tool timeline entry - represents a single tool call */
export interface ToolTimelineEntry {
	/** Unique ID for this tool call */
	id: string;
	/** Tool name (e.g., "bash", "read", "edit") */
	toolName: string;
	/** When the tool call started (unix ms) */
	startedAt: number;
	/** Duration in milliseconds */
	durationMs: number;
	/** Whether the tool completed successfully */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Number of output characters (approx) */
	outputChars?: number;
}

/** Tool usage summary aggregated across a session or branch */
export interface ToolUsageSummary {
	/** Tool name */
	toolName: string;
	/** Total number of calls */
	totalCalls: number;
	/** Number of successful calls */
	successfulCalls: number;
	/** Number of failed calls */
	failedCalls: number;
	/** Total time spent on this tool (ms) */
	totalDurationMs: number;
	/** Average call duration (ms) */
	avgDurationMs: number;
}

/** Branch summary metadata */
export interface BranchSummary {
	/** Unique branch ID */
	branchId: string;
	/** Parent branch ID (null for root) */
	parentId: string | null;
	/** Number of messages in this branch */
	messageCount: number;
	/** Total number of tool calls */
	toolCallCount: number;
	/** When the branch started */
	startedAt: number;
	/** When the branch ended (null if current) */
	endedAt: number | null;
	/** Model used for this branch (from last assistant message) */
	model?: string;
	/** Total duration from start to end (ms) */
	totalDurationMs: number | null;
	/** Whether this is the current/active branch */
	isCurrentBranch: boolean;
}

/** TTSR rule injection record */
export interface TtsrInjection {
	/** Name of the injected rule */
	ruleName: string;
	/** When the injection occurred (unix ms) */
	injectedAt: number;
	/** Turn index when injected */
	turnIndex: number;
	/** Rule content (truncated) */
	contentPreview: string;
}

/** Type of session event */
export type SessionEventType =
	| "retry"
	| "retry_fallback"
	| "compaction"
	| "ttsr"
	| "budget_warning"
	| "budget_exceeded"
	| "subagent_start"
	| "subagent_end"
	| "subagent_verification"
	| "subagent_verification_start"
	| "subagent_verification_end"
	| "ttsr_triggered"
	| "auto_retry_start"
	| "auto_retry_end"
	| "auto_compaction_start"
	| "auto_compaction_end";

/** Generic session event for replay */
export interface SessionEventEntry {
	/** Event type */
	type: SessionEventType;
	/** When the event occurred (unix ms) */
	timestamp: number;
	/** Event data */
	data: Record<string, unknown>;
}

/** Full replay snapshot */
export interface ReplaySnapshot {
	/** Session identifier */
	sessionId: string;
	/** Path to session file */
	sessionPath: string;
	/** When the session started */
	startedAt: number;
	/** When the session ended (null if ongoing) */
	endedAt: number | null;
	/** Current branch ID */
	currentBranchId: string;
	/** Session tree structure */
	tree: SessionTreeNode[];
	/** Tool call timeline (chronological) */
	timeline: ToolTimelineEntry[];
	/** Tool usage summaries */
	toolUsage: ToolUsageSummary[];
	/** Branch summaries */
	branches: BranchSummary[];
	/** TTSR injections */
	ttsrInjections: TtsrInjection[];
	/** Session events (retries, compactions, etc.) */
	events: SessionEventEntry[];
	/** Total statistics */
	stats: {
		totalMessages: number;
		totalToolCalls: number;
		totalDurationMs: number | null;
		turnCount: number;
	};
}

/** Export format options */
export type ExportFormat = "json" | "summary";

/** Summary output for CLI */
export interface SessionSummary {
	sessionId: string;
	startedAt: string;
	duration: string;
	branchCount: number;
	currentBranch: string;
	messageCount: number;
	toolCallCount: number;
	topTools: Array<{ name: string; count: number }>;
	events: Array<{ type: string; count: number }>;
}
