/**
 * Session Inspector - provides structured access to session data for replay and analysis.
 *
 * This class aggregates session events, tool calls, and branch metadata into
 * replayable structures that can be consumed by UI visualizers or CLI tools.
 */

import type { SessionTreeNode } from "../session-manager";
import type {
	BranchSummary,
	ReplaySnapshot,
	SessionEventEntry,
	SessionEventType,
	SessionSummary,
	ToolTimelineEntry,
	ToolUsageSummary,
	TtsrInjection,
} from "./types";

/** Event types we track */
const TRACKED_EVENT_TYPES = new Set<SessionEventType>([
	"retry",
	"retry_fallback",
	"compaction",
	"ttsr",
	"budget_warning",
	"budget_exceeded",
	"subagent_start",
	"subagent_end",
	"subagent_verification",
	"subagent_verification_start",
	"subagent_verification_end",
	"ttsr_triggered",
	"auto_retry_start",
	"auto_retry_end",
	"auto_compaction_start",
	"auto_compaction_end",
]);

/** Raw event from session */
interface RawSessionEvent {
	type: string;
	timestamp?: string | number;
	[key: string]: unknown;
}

/** Entry with timestamp as number */
interface TimestampedEntry {
	id: string;
	type: string;
	timestamp: number;
	parentId: string | null;
	parentIdChain?: string[];
	message?: {
		role?: string;
		toolCalls?: unknown[];
		model?: string;
	};
}

/**
 * Session inspector for replay and analysis.
 *
 * Provides methods to extract structured data from a session for:
 * - Replay: Build snapshot of session state
 * - Analysis: Aggregate tool usage, branch metadata
 * - Visualization: Tree structure, timelines, summaries
 */
export class SessionInspector {
	/** Map of tool call start events (id -> start time) */
	#toolCallStarts = new Map<string, number>();

	/** Accumulated tool call events */
	#toolCalls: ToolTimelineEntry[] = [];

	/** TTSR injections */
	#ttsrInjections: TtsrInjection[] = [];

	/** Session events (retries, compactions, etc.) */
	#sessionEvents: SessionEventEntry[] = [];

	/** Track current branch ID */
	#currentBranchId: string;

	constructor(
		private readonly sessionId: string,
		private readonly sessionPath: string,
		private readonly tree: SessionTreeNode[],
		private readonly entries: TimestampedEntry[],
		readonly _leafId: string,
	) {
		this.#currentBranchId = _leafId;
	}

	/**
	 * Parse timestamp to number (handles both string and number formats).
	 */
	#parseTimestamp(ts: string | number | undefined): number {
		if (ts === undefined) return Date.now();
		if (typeof ts === "number") return ts;
		// ISO string or unix ms string
		const parsed = Date.parse(ts);
		return Number.isNaN(parsed) ? Number(ts) : parsed;
	}

	/**
	 * Process a session event and update internal state.
	 */
	processEvent(event: RawSessionEvent): void {
		const eventType = event.type as SessionEventType;

		if (!TRACKED_EVENT_TYPES.has(eventType)) {
			return;
		}

		const timestamp = this.#parseTimestamp(event.timestamp);

		switch (eventType) {
			case "ttsr_triggered": {
				const rules = event.rules as Array<{ name: string; content: string }> | undefined;
				if (rules) {
					for (const rule of rules) {
						this.#ttsrInjections.push({
							ruleName: rule.name,
							injectedAt: timestamp,
							turnIndex: (event.turnIndex as number) ?? 0,
							contentPreview: rule.content.slice(0, 200),
						});
					}
				}
				break;
			}

			case "auto_retry_start":
			case "auto_retry_end":
				this.#sessionEvents.push({
					type: "retry",
					timestamp,
					data: event as Record<string, unknown>,
				});
				break;

			case "auto_compaction_start":
			case "auto_compaction_end":
				this.#sessionEvents.push({
					type: "compaction",
					timestamp,
					data: event as Record<string, unknown>,
				});
				break;

			case "budget_warning":
				this.#sessionEvents.push({
					type: "budget_warning",
					timestamp,
					data: event as Record<string, unknown>,
				});
				break;

			case "budget_exceeded":
				this.#sessionEvents.push({
					type: "budget_exceeded",
					timestamp,
					data: event as Record<string, unknown>,
				});
				break;

			case "subagent_start":
			case "subagent_end":
			case "subagent_verification_start":
			case "subagent_verification_end":
				this.#sessionEvents.push({
					type: "subagent_start",
					timestamp,
					data: event as Record<string, unknown>,
				});
				break;

			default:
				this.#sessionEvents.push({
					type: eventType,
					timestamp,
					data: event as Record<string, unknown>,
				});
		}
	}

	/**
	 * Record a tool call start.
	 */
	recordToolCallStart(id: string, _toolName: string, startedAt: number): void {
		this.#toolCallStarts.set(id, startedAt);
	}

	/**
	 * Record a tool call end.
	 */
	recordToolCallEnd(id: string, toolName: string, endedAt: number, success: boolean, error?: string): void {
		const startedAt = this.#toolCallStarts.get(id);
		if (startedAt !== undefined) {
			this.#toolCalls.push({
				id,
				toolName,
				startedAt,
				durationMs: endedAt - startedAt,
				success,
				error,
			});
			this.#toolCallStarts.delete(id);
		}
	}

	/**
	 * Set the current branch ID (called when session branches).
	 */
	setCurrentBranch(branchId: string): void {
		this.#currentBranchId = branchId;
	}

	/**
	 * Get the tool call timeline.
	 */
	getToolTimeline(): ToolTimelineEntry[] {
		return [...this.#toolCalls].sort((a, b) => a.startedAt - b.startedAt);
	}

	/**
	 * Get tool usage summaries aggregated by tool name.
	 */
	getToolUsageSummaries(): ToolUsageSummary[] {
		const byTool = new Map<string, ToolTimelineEntry[]>();

		for (const call of this.#toolCalls) {
			const existing = byTool.get(call.toolName) ?? [];
			existing.push(call);
			byTool.set(call.toolName, existing);
		}

		const summaries: ToolUsageSummary[] = [];

		for (const [toolName, calls] of byTool) {
			const successful = calls.filter(c => c.success);
			const failed = calls.filter(c => !c.success);
			const totalDuration = calls.reduce((sum, c) => sum + c.durationMs, 0);

			summaries.push({
				toolName,
				totalCalls: calls.length,
				successfulCalls: successful.length,
				failedCalls: failed.length,
				totalDurationMs: totalDuration,
				avgDurationMs: Math.round(totalDuration / calls.length),
			});
		}

		// Sort by total calls descending
		return summaries.sort((a, b) => b.totalCalls - a.totalCalls);
	}

	/**
	 * Get TTSR injections.
	 */
	getTtsrInjections(): TtsrInjection[] {
		return [...this.#ttsrInjections];
	}

	/**
	 * Get session events (retries, compactions, etc.).
	 */
	getSessionEvents(): SessionEventEntry[] {
		return [...this.#sessionEvents].sort((a, b) => a.timestamp - b.timestamp);
	}

	/**
	 * Get branch summaries.
	 */
	getBranchSummaries(): BranchSummary[] {
		const summaries: BranchSummary[] = [];

		// Recursive function to traverse tree
		const traverse = (nodes: SessionTreeNode[], parentId: string | null): void => {
			for (const node of nodes) {
				const branchId = node.entry.id;
				const messages = this.getMessagesInBranch(branchId);
				const toolCalls = this.countToolCalls(messages);
				const startedAt = this.#parseTimestamp(node.entry.timestamp);
				const endedAt = this.getBranchEndTime(branchId);
				const model = this.getBranchModel(messages);

				summaries.push({
					branchId,
					parentId,
					messageCount: messages.length,
					toolCallCount: toolCalls,
					startedAt,
					endedAt,
					model,
					totalDurationMs: endedAt ? endedAt - startedAt : null,
					isCurrentBranch: branchId === this.#currentBranchId,
				});

				if (node.children.length > 0) {
					traverse(node.children, branchId);
				}
			}
		};

		traverse(this.tree, null);
		return summaries;
	}

	/**
	 * Get messages belonging to a specific branch.
	 */
	private getMessagesInBranch(branchId: string): TimestampedEntry[] {
		// Find all entries in this branch
		const branchEntries = this.entries.filter(e => {
			// Entry is in branch if it's the entry itself or a descendant
			if (e.id === branchId) return true;

			// Check if this is a message entry in the branch
			const parentChain = e.parentIdChain ?? [];
			return parentChain.includes(branchId);
		});

		return branchEntries.filter(e => e.type === "message");
	}

	/**
	 * Count tool calls in a set of messages.
	 */
	private countToolCalls(messages: TimestampedEntry[]): number {
		return messages.reduce((count, msg) => {
			const toolCalls = msg.message?.toolCalls;
			if (toolCalls && Array.isArray(toolCalls)) {
				return count + toolCalls.length;
			}
			return count;
		}, 0);
	}

	/**
	 * Get the model used in a branch (from last assistant message).
	 */
	private getBranchModel(messages: TimestampedEntry[]): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i].message;
			if (msg?.role === "assistant" && msg?.model) {
				return msg.model;
			}
		}
		return undefined;
	}

	/**
	 * Get end time for a branch (start of next branch or null).
	 */
	private getBranchEndTime(branchId: string): number | null {
		// Find the next entry that starts a new branch
		const entry = this.entries.find(e => e.id === branchId);
		if (!entry) return null;

		const entryIndex = this.entries.indexOf(entry);
		const startedAt = entry.timestamp;

		// Find the next entry that starts after this one (new branch)
		for (let i = entryIndex + 1; i < this.entries.length; i++) {
			const nextEntry = this.entries[i];
			if (nextEntry.timestamp > startedAt) {
				return nextEntry.timestamp;
			}
		}

		// No later entry found - this might be the current branch
		return null;
	}

	/**
	 * Build a full replay snapshot.
	 */
	getSnapshot(): ReplaySnapshot {
		const entries = this.entries;
		const startedAt = entries[0]?.timestamp ?? 0;
		const endedAt = entries[entries.length - 1]?.timestamp ?? null;

		// Count total messages and turns
		const messages = entries.filter(e => e.type === "message");
		const turns = messages.filter(e => e.message?.role === "assistant");

		return {
			sessionId: this.sessionId,
			sessionPath: this.sessionPath,
			startedAt,
			endedAt,
			currentBranchId: this.#currentBranchId,
			tree: this.tree,
			timeline: this.getToolTimeline(),
			toolUsage: this.getToolUsageSummaries(),
			branches: this.getBranchSummaries(),
			ttsrInjections: this.getTtsrInjections(),
			events: this.getSessionEvents(),
			stats: {
				totalMessages: messages.length,
				totalToolCalls: this.#toolCalls.length,
				totalDurationMs: endedAt ? endedAt - startedAt : null,
				turnCount: turns.length,
			},
		};
	}

	/**
	 * Export snapshot as JSON string.
	 */
	exportToJson(): string {
		return JSON.stringify(this.getSnapshot(), null, 2);
	}

	/**
	 * Generate a human-readable summary.
	 */
	getSummary(): SessionSummary {
		const snapshot = this.getSnapshot();
		const topTools = snapshot.toolUsage.slice(0, 5).map(t => ({
			name: t.toolName,
			count: t.totalCalls,
		}));

		// Count events by type
		const eventCounts = new Map<string, number>();
		for (const event of snapshot.events) {
			eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
		}

		const formatDuration = (ms: number | null): string => {
			if (ms === null) return "ongoing";
			const seconds = Math.floor(ms / 1000);
			const minutes = Math.floor(seconds / 60);
			const hours = Math.floor(minutes / 60);
			if (hours > 0) return `${hours}h ${minutes % 60}m`;
			if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
			return `${seconds}s`;
		};

		return {
			sessionId: snapshot.sessionId,
			startedAt: new Date(snapshot.startedAt).toISOString(),
			duration: formatDuration(snapshot.stats.totalDurationMs),
			branchCount: snapshot.branches.length,
			currentBranch: snapshot.currentBranchId,
			messageCount: snapshot.stats.totalMessages,
			toolCallCount: snapshot.stats.totalToolCalls,
			topTools,
			events: Array.from(eventCounts.entries()).map(([type, count]) => ({ type, count })),
		};
	}
}
