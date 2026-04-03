import { describe, expect, test } from "bun:test";
import type { SessionTreeNode } from "../session-manager";
import { SessionInspector } from "./SessionInspector";

describe("SessionInspector", () => {
	const createInspector = () => {
		const tree: SessionTreeNode[] = [
			{
				entry: {
					type: "message",
					id: "msg-1",
					timestamp: "2024-01-01T10:00:00.000Z",
					parentId: null,
				} as SessionTreeNode["entry"],
				children: [],
			},
		];

		const entries = [
			{
				id: "msg-1",
				type: "message",
				timestamp: new Date("2024-01-01T10:00:00.000Z").getTime(),
				parentId: null,
				message: { role: "user", content: "Hello" },
			},
		];

		return new SessionInspector("session-1", "/path/to/session.jsonl", tree, entries as never, "msg-1");
	};

	describe("tool timeline", () => {
		test("records tool call start and end", () => {
			const inspector = createInspector();

			inspector.recordToolCallStart("tool-1", "bash", 1000);
			inspector.recordToolCallEnd("tool-1", "bash", 1500, true);

			const timeline = inspector.getToolTimeline();
			expect(timeline).toHaveLength(1);
			expect(timeline[0].toolName).toBe("bash");
			expect(timeline[0].durationMs).toBe(500);
			expect(timeline[0].success).toBe(true);
		});

		test("handles failed tool calls", () => {
			const inspector = createInspector();

			inspector.recordToolCallStart("tool-1", "edit", 1000);
			inspector.recordToolCallEnd("tool-1", "edit", 1200, false, "File not found");

			const timeline = inspector.getToolTimeline();
			expect(timeline[0].success).toBe(false);
			expect(timeline[0].error).toBe("File not found");
		});

		test("sorts timeline by start time", () => {
			const inspector = createInspector();

			inspector.recordToolCallStart("tool-2", "read", 2000);
			inspector.recordToolCallEnd("tool-2", "read", 2100, true);
			inspector.recordToolCallStart("tool-1", "bash", 1000);
			inspector.recordToolCallEnd("tool-1", "bash", 1100, true);

			const timeline = inspector.getToolTimeline();
			expect(timeline[0].toolName).toBe("bash");
			expect(timeline[1].toolName).toBe("read");
		});
	});

	describe("tool usage summaries", () => {
		test("aggregates by tool name", () => {
			const inspector = createInspector();

			inspector.recordToolCallStart("tool-1", "bash", 1000);
			inspector.recordToolCallEnd("tool-1", "bash", 1100, true);
			inspector.recordToolCallStart("tool-2", "bash", 2000);
			inspector.recordToolCallEnd("tool-2", "bash", 2200, true);
			inspector.recordToolCallStart("tool-3", "read", 3000);
			inspector.recordToolCallEnd("tool-3", "read", 3100, true);

			const summaries = inspector.getToolUsageSummaries();

			expect(summaries).toHaveLength(2);

			const bashSummary = summaries.find(s => s.toolName === "bash");
			expect(bashSummary?.totalCalls).toBe(2);
			expect(bashSummary?.successfulCalls).toBe(2);
			expect(bashSummary?.totalDurationMs).toBe(300);
		});

		test("sorts by total calls descending", () => {
			const inspector = createInspector();

			// 3 read calls
			for (let i = 0; i < 3; i++) {
				inspector.recordToolCallStart(`tool-${i}`, "read", i * 1000);
				inspector.recordToolCallEnd(`tool-${i}`, "read", i * 1000 + 100, true);
			}
			// 1 bash call
			inspector.recordToolCallStart("tool-x", "bash", 5000);
			inspector.recordToolCallEnd("tool-x", "bash", 5100, true);

			const summaries = inspector.getToolUsageSummaries();
			expect(summaries[0].toolName).toBe("read");
			expect(summaries[0].totalCalls).toBe(3);
			expect(summaries[1].toolName).toBe("bash");
		});
	});

	describe("session events", () => {
		test("processes retry events", () => {
			const inspector = createInspector();

			inspector.processEvent({
				type: "auto_retry_start",
				timestamp: "2024-01-01T10:00:00.000Z",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 1000,
				errorMessage: "Rate limited",
			});

			const events = inspector.getSessionEvents();
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("retry");
			expect(events[0].data.attempt).toBe(1);
		});

		test("processes compaction events", () => {
			const inspector = createInspector();

			inspector.processEvent({
				type: "auto_compaction_start",
				timestamp: "2024-01-01T10:00:00.000Z",
				reason: "threshold",
				action: "context-full",
			});

			const events = inspector.getSessionEvents();
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("compaction");
		});

		test("processes TTSR injections", () => {
			const inspector = createInspector();

			inspector.processEvent({
				type: "ttsr_triggered",
				timestamp: "2024-01-01T10:00:00.000Z",
				turnIndex: 5,
				rules: [{ name: "rule-1", content: "Test rule content" }],
			});

			const injections = inspector.getTtsrInjections();
			expect(injections).toHaveLength(1);
			expect(injections[0].ruleName).toBe("rule-1");
			expect(injections[0].turnIndex).toBe(5);
			expect(injections[0].contentPreview).toBe("Test rule content");
		});

		test("ignores untracked events", () => {
			const inspector = createInspector();

			inspector.processEvent({
				type: "untracked_event",
				timestamp: "2024-01-01T10:00:00.000Z",
			});

			const events = inspector.getSessionEvents();
			expect(events).toHaveLength(0);
		});
	});

	describe("snapshot", () => {
		test("builds complete snapshot", () => {
			const inspector = createInspector();

			inspector.recordToolCallStart("tool-1", "bash", 1000);
			inspector.recordToolCallEnd("tool-1", "bash", 1500, true);

			inspector.processEvent({
				type: "auto_retry_start",
				timestamp: "2024-01-01T10:00:00.000Z",
				attempt: 1,
			});

			const snapshot = inspector.getSnapshot();

			expect(snapshot.sessionId).toBe("session-1");
			expect(snapshot.sessionPath).toBe("/path/to/session.jsonl");
			expect(snapshot.stats.totalToolCalls).toBe(1);
			expect(snapshot.events).toHaveLength(1);
			expect(snapshot.branches).toHaveLength(1);
		});

		test("exports to JSON", () => {
			const inspector = createInspector();
			const json = inspector.exportToJson();

			const parsed = JSON.parse(json);
			expect(parsed.sessionId).toBe("session-1");
		});
	});

	describe("summary", () => {
		test("formats duration correctly", () => {
			const inspector = createInspector();
			const summary = inspector.getSummary();

			expect(summary.sessionId).toBe("session-1");
			expect(summary.duration).toBeTruthy();
		});
	});
});
