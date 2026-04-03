/**
 * ShoalOrchestrator — runs a TeamDefinition as a Shoal-backed multi-agent pipeline.
 *
 * Execution model:
 *   1. Parse team YAML → TeamDefinition
 *   2. Build dependency graph → execution waves (topological sort)
 *   3. For each wave, in parallel:
 *      a. create_session for each agent (with template, worktree, prompt)
 *      b. poll via session_snapshot until all agents complete or fail
 *      c. collect output artifacts via read_worktree_file
 *   4. Cleanup: kill sessions, optionally keep worktrees for manual inspection
 *   5. Report results
 *
 * Workers signal completion by calling the Shoal MCP tool `mark_complete` from
 * within their session. The orchestrator waits on `wait_for_completion`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { triggerExpertiseFin } from "./expertise";
import type { SessionActionObject, ShoalMcpBridge } from "./session-lifecycle";
import {
	buildTeamDependencyGraph,
	buildTeamExecutionWaves,
	detectTeamCycles,
	type TeamDefinition,
} from "./team-schema";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface AgentRunState {
	name: string;
	status: AgentRunStatus;
	sessionName: string;
	startedAt?: number;
	completedAt?: number;
	error?: string;
}

export interface OrchestrationProgress {
	teamName: string;
	correlationId: string;
	agents: Map<string, AgentRunState>;
	currentWave: number;
	totalWaves: number;
	startedAt: number;
	/** Pending action requests blocking the next wave. Cleared when all are resolved. */
	pendingActions?: SessionActionObject[];
	awaitingApproval?: boolean;
}

export interface OrchestrationResult {
	status: "completed" | "failed" | "aborted";
	correlationId: string;
	agents: Map<string, AgentRunState>;
	elapsedMs: number;
	errors: string[];
}

export interface OrchestrationOptions {
	/** Called on each status change for live TUI widget updates. */
	onProgress?: (progress: OrchestrationProgress) => void;
	/** Completion poll interval in ms (default 5000). */
	pollIntervalMs?: number;
	/** Per-agent wait timeout in seconds (default 600 — 10 min). */
	agentTimeoutSeconds?: number;
	/** If true, kill sessions and remove worktrees after completion. Default true. */
	cleanup?: boolean;
	/** If true, trigger expertise fins after each session. Default true. */
	updateExpertise?: boolean;
	/** AbortSignal to cancel the run. */
	signal?: AbortSignal;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionNameFor(teamName: string, agentName: string): string {
	return `${teamName}-${agentName}`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export class ShoalOrchestrator {
	#aborted = false;

	constructor(private bridge: ShoalMcpBridge) {}

	abort(): void {
		this.#aborted = true;
	}

	async run(def: TeamDefinition, opts: OrchestrationOptions = {}): Promise<OrchestrationResult> {
		const {
			onProgress,
			pollIntervalMs = 5_000,
			agentTimeoutSeconds = 600,
			cleanup = true,
			updateExpertise = true,
			signal,
		} = opts;

		// Build dependency graph and waves
		const deps = buildTeamDependencyGraph(def);
		const cycles = detectTeamCycles(deps);
		if (cycles) {
			throw new Error(`Cycle detected in team dependencies: [${cycles.join(", ")}]`);
		}
		const waves = buildTeamExecutionWaves(deps);

		// Generate a stable workflow identity for this run
		const correlationId = `wf_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

		// Resolve workspace path (relative to def.path)
		const projectPath = path.isAbsolute(def.path) ? def.path : path.resolve(def.path);
		const workspacePath = path.isAbsolute(def.workspace) ? def.workspace : path.resolve(projectPath, def.workspace);
		await fs.mkdir(workspacePath, { recursive: true });

		// Initialize progress state
		const agents = new Map<string, AgentRunState>();
		for (const name of def.agents.keys()) {
			agents.set(name, {
				name,
				status: "pending",
				sessionName: sessionNameFor(def.name, name),
			});
		}

		const progress: OrchestrationProgress = {
			teamName: def.name,
			correlationId,
			agents,
			currentWave: 0,
			totalWaves: waves.length,
			startedAt: Date.now(),
		};

		const errors: string[] = [];
		const spawnedSessions: string[] = [];

		const emit = () => onProgress?.(progress);
		emit();

		try {
			for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
				if (this.#aborted || signal?.aborted) break;

				progress.currentWave = waveIdx + 1;
				const wave = waves[waveIdx];
				const waveAgents = wave.map(n => def.agents.get(n)!);

				logger.debug("Team wave starting", {
					team: def.name,
					wave: waveIdx + 1,
					agents: wave,
				});

				// ── Spawn all agents in this wave ──────────────────────────────
				await Promise.all(
					waveAgents.map(async agent => {
						const state = agents.get(agent.name)!;
						state.status = "running";
						state.startedAt = Date.now();
						emit();

						try {
							const session = await this.bridge.createSession({
								name: state.sessionName,
								path: projectPath,
								template: agent.template,
								worktree: agent.worktree ? agent.name : undefined,
								branch: agent.branch,
								prompt: agent.prompt,
							});
							spawnedSessions.push(session.name);
							await this.bridge.appendJournal(
								session.name,
								`[orchestrator] ${correlationId} Team '${def.name}' wave ${waveIdx + 1}: started`,
							);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							state.status = "failed";
							state.error = msg;
							state.completedAt = Date.now();
							errors.push(`${agent.name}: spawn failed — ${msg}`);
							emit();
						}
					}),
				);

				// ── Poll until all running agents in this wave complete ─────────
				const runningAgents = waveAgents.filter(a => agents.get(a.name)!.status === "running");

				if (runningAgents.length > 0) {
					await this.#pollWave(
						runningAgents.map(a => sessionNameFor(def.name, a.name)),
						agents,
						def.name,
						{
							pollIntervalMs,
							agentTimeoutSeconds,
							errors,
							emit,
							signal,
						},
					);
				}

				// Abort the whole run if any agent in this wave failed
				const waveFailed = waveAgents.some(a => agents.get(a.name)!.status === "failed");
				if (waveFailed) {
					logger.warn("Team wave failed, aborting remaining waves", {
						team: def.name,
						wave: waveIdx + 1,
					});
					break;
				}

				// ── Check for pending action requests before next wave ──────────
				if (!this.#aborted && !signal?.aborted) {
					const pendingActions = await this.bridge.listPendingActions({ correlationId });
					if (pendingActions.length > 0) {
						progress.pendingActions = pendingActions;
						progress.awaitingApproval = true;
						emit();
						await this.#pollUntilActionsCleared(correlationId, progress, emit, pollIntervalMs, signal);
					}
				}
			}
		} finally {
			// ── Expertise fins ─────────────────────────────────────────────────
			if (updateExpertise) {
				for (const [agentName, state] of agents) {
					if (state.status !== "completed") continue;
					const agent = def.agents.get(agentName)!;
					try {
						await triggerExpertiseFin(state.sessionName, agent.template);
					} catch (err) {
						logger.warn("Expertise fin failed", {
							session: state.sessionName,
							template: agent.template,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}

			// ── Cleanup ────────────────────────────────────────────────────────
			if (cleanup) {
				await Promise.allSettled(
					spawnedSessions.map(sessionName =>
						this.bridge.killSession(sessionName, { removeWorktree: false }).catch(err =>
							logger.warn("Failed to kill session on cleanup", {
								session: sessionName,
								error: err instanceof Error ? err.message : String(err),
							}),
						),
					),
				);
			}
		}

		const allDone = [...agents.values()].every(s => ["completed", "failed", "aborted"].includes(s.status));
		const anyFailed = [...agents.values()].some(s => s.status === "failed");
		const isAborted = this.#aborted || signal?.aborted;

		return {
			status: isAborted ? "aborted" : anyFailed ? "failed" : allDone ? "completed" : "failed",
			correlationId,
			agents,
			elapsedMs: Date.now() - progress.startedAt,
			errors,
		};
	}

	// ── Poll a wave until all sessions complete or time out ───────────────────

	async #pollWave(
		sessionNames: string[],
		agents: Map<string, AgentRunState>,
		teamName: string,
		opts: {
			pollIntervalMs: number;
			agentTimeoutSeconds: number;
			errors: string[];
			emit: () => void;
			signal?: AbortSignal;
		},
	): Promise<void> {
		const { pollIntervalMs, agentTimeoutSeconds, errors, emit, signal } = opts;
		const deadlines = new Map(sessionNames.map(n => [n, Date.now() + agentTimeoutSeconds * 1_000]));
		const pending = new Set(sessionNames);

		while (pending.size > 0 && !this.#aborted && !signal?.aborted) {
			let snapshot: { sessions: { name: string; status?: string }[] };
			try {
				snapshot = await this.bridge.sessionSnapshot([...pending], ["status", "pane"]);
			} catch (err) {
				logger.warn("session_snapshot failed", { error: err });
				await Bun.sleep(pollIntervalMs);
				continue;
			}

			const byName = new Map(snapshot.sessions.map(s => [s.name, s]));

			for (const sessionName of [...pending]) {
				const entry = byName.get(sessionName);
				const status = entry?.status?.toLowerCase() ?? "unknown";
				const agentName = sessionName.slice(teamName.length + 1); // strip "<team>-" prefix
				const state = agents.get(agentName);
				if (!state) continue;

				// Shoal statuses: idle, busy, completed, killed, error
				if (status === "completed") {
					state.status = "completed";
					state.completedAt = Date.now();
					pending.delete(sessionName);
					emit();
				} else if (status === "error" || status === "killed") {
					state.status = "failed";
					state.error = `Session ended with status: ${status}`;
					state.completedAt = Date.now();
					errors.push(`${agentName}: session ended with status '${status}'`);
					pending.delete(sessionName);
					emit();
				} else if (Date.now() > (deadlines.get(sessionName) ?? 0)) {
					state.status = "failed";
					state.error = `Timed out after ${agentTimeoutSeconds}s`;
					state.completedAt = Date.now();
					errors.push(`${agentName}: timed out`);
					pending.delete(sessionName);
					emit();
				}
			}

			if (pending.size > 0) await Bun.sleep(pollIntervalMs);
		}

		// Mark any still-pending agents as aborted
		for (const sessionName of pending) {
			const agentName = sessionName.slice(teamName.length + 1);
			const state = agents.get(agentName);
			if (state && state.status === "running") {
				state.status = "aborted";
				state.completedAt = Date.now();
			}
		}
		emit();
	}

	// ── Poll until all pending actions for this workflow are resolved ─────────

	async #pollUntilActionsCleared(
		correlationId: string,
		progress: OrchestrationProgress,
		emit: () => void,
		pollIntervalMs: number,
		signal: AbortSignal | undefined,
	): Promise<void> {
		while (!this.#aborted && !signal?.aborted) {
			let pending: SessionActionObject[];
			try {
				pending = await this.bridge.listPendingActions({ correlationId });
			} catch {
				pending = [];
			}
			progress.pendingActions = pending.length > 0 ? pending : undefined;
			progress.awaitingApproval = pending.length > 0;
			emit();
			if (pending.length === 0) return;
			await Bun.sleep(pollIntervalMs);
		}
		// Aborted — clear state
		progress.pendingActions = undefined;
		progress.awaitingApproval = false;
	}
}

// ── Progress rendering ────────────────────────────────────────────────────────

const STATUS_ICON: Record<AgentRunStatus, string> = {
	pending: "○",
	running: "●",
	completed: "✓",
	failed: "✗",
	aborted: "⊘",
};

export function renderTeamProgress(progress: OrchestrationProgress): string[] {
	const elapsed = Math.round((Date.now() - progress.startedAt) / 1_000);
	const lines: string[] = [
		`Team: ${progress.teamName}  [${progress.correlationId}]  wave ${progress.currentWave}/${progress.totalWaves}  ${elapsed}s`,
	];
	for (const [name, state] of progress.agents) {
		const icon = STATUS_ICON[state.status];
		const duration =
			state.startedAt && state.completedAt
				? `${Math.round((state.completedAt - state.startedAt) / 1_000)}s`
				: state.startedAt
					? `${Math.round((Date.now() - state.startedAt) / 1_000)}s`
					: "";
		const suffix = state.error ? `  ! ${state.error}` : duration ? `  ${duration}` : "";
		lines.push(`  ${icon} ${name}${suffix}`);
	}
	if (progress.awaitingApproval && progress.pendingActions?.length) {
		lines.push("  -- awaiting approval --");
		for (const action of progress.pendingActions) {
			lines.push(`  [${action.id}] ${action.action_type}  from: ${action.requester_session}`);
			lines.push(`        /team approve ${action.id}  or  /team deny ${action.id}`);
		}
	}
	return lines;
}
