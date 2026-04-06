import { describe, expect, it } from "bun:test";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { type AgentProgress, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "task-1",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect task state",
		assignment: "Read the current task state and report back.",
		description: "Inspect state",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		...overrides,
	};
}

describe("SessionObserverRegistry", () => {
	it("tracks main session and subagent lifecycle updates", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		registry.setMainSession("/tmp/main.jsonl");

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "task-1",
			agent: "task",
			agentSource: "bundled",
			description: "Inspect state",
			status: "started",
			sessionFile: "/tmp/task-1.jsonl",
			index: 0,
		});

		expect(registry.getActiveSubagentCount()).toBe(1);
		const sessions = registry.getSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.id).toBe("main");
		expect(sessions[1]?.id).toBe("task-1");
		expect(sessions[1]?.status).toBe("active");
		expect(sessions[1]?.sessionFile).toBe("/tmp/task-1.jsonl");

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "task-1",
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			index: 0,
		});

		expect(registry.getActiveSubagentCount()).toBe(0);
		expect(registry.getSessions()[1]?.status).toBe("completed");
	});

	it("merges progress updates onto tracked subagent sessions", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Inspect task state",
			assignment: "Read the current task state and report back.",
			progress: createProgress({
				currentTool: "read",
				lastIntent: "Read the session state file",
				description: "Inspect state",
			}),
			sessionFile: "/tmp/task-1.jsonl",
		});

		const tracked = registry.getSessions()[0];
		expect(tracked?.id).toBe("task-1");
		expect(tracked?.status).toBe("active");
		expect(tracked?.description).toBe("Inspect state");
		expect(tracked?.sessionFile).toBe("/tmp/task-1.jsonl");
		expect(tracked?.progress?.currentTool).toBe("read");
		expect(tracked?.progress?.lastIntent).toBe("Read the session state file");
	});
	it("resetSessions clears all tracked sessions and notifies listeners", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		registry.setMainSession("/tmp/main.jsonl");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "task-1",
			agent: "task",
			agentSource: "bundled",
			description: "Test",
			status: "started",
			sessionFile: "/tmp/task-1.jsonl",
			index: 0,
		});
		expect(registry.getSessions()).toHaveLength(2);

		let notified = 0;
		registry.onChange(() => notified++);
		registry.resetSessions();

		expect(registry.getSessions()).toHaveLength(0);
		expect(registry.getActiveSubagentCount()).toBe(0);
		expect(notified).toBe(1);
	});

	it("onChange fires on lifecycle events", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		let notified = 0;
		registry.onChange(() => notified++);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "task-1",
			agent: "task",
			agentSource: "bundled",
			description: "Test",
			status: "started",
			sessionFile: "/tmp/task-1.jsonl",
			index: 0,
		});
		expect(notified).toBe(1);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "task-1",
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			index: 0,
		});
		expect(notified).toBe(2);
	});
});
