/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import taskVerificationRepairTemplate from "../prompts/task/task-verification-repair.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import type { AgentSessionEvent } from "../session/agent-session";
import { formatBytes, formatDuration } from "../tools/render-utils";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { resolveIsolationBackendForTaskExecution } from "./isolation-backend";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { renderCall, renderResult } from "./render";
import { renderTemplate } from "./template";
import {
	type AgentDefinition,
	type AgentProgress,
	type SingleResult,
	type TaskParams,
	type TaskSchema,
	type TaskToolDetails,
	type TaskVerifyConfig,
	taskSchema,
	taskSchemaNoIsolation,
	type VerificationAttemptResult,
	type VerificationCommand,
	type VerificationFailurePolicy,
	type VerificationResult,
} from "./types";
import {
	applyBaseline,
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupFuseOverlay,
	cleanupProjfsOverlay,
	cleanupTaskBranches,
	cleanupWorktree,
	commitToBranch,
	ensureFuseOverlay,
	ensureProjfsOverlay,
	ensureWorktree,
	getRepoRoot,
	mergeTaskBranches,
	type WorktreeBaseline,
} from "./worktree";

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

interface ResolvedTaskVerification {
	requested: boolean;
	profile?: string;
	mode: "none" | "command";
	commands: VerificationCommand[];
	maxRetries: number;
	onFailure: VerificationFailurePolicy;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerificationCommand(value: unknown): VerificationCommand | undefined {
	if (!isRecord(value)) return undefined;
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const command = typeof value.command === "string" ? value.command.trim() : "";
	if (!name || !command) return undefined;
	const timeoutMs = typeof value.timeoutMs === "number" && value.timeoutMs > 0 ? value.timeoutMs : undefined;
	const optional = value.optional === true ? true : undefined;
	return { name, command, timeoutMs, optional };
}

function normalizeTaskVerifyConfig(value: unknown): TaskVerifyConfig | undefined {
	if (!isRecord(value)) return undefined;
	const profile = typeof value.profile === "string" && value.profile.trim() ? value.profile.trim() : undefined;
	const mode =
		value.mode === "none" || value.mode === "command" || value.mode === "lsp" || value.mode === "profile"
			? value.mode
			: undefined;
	const commands = Array.isArray(value.commands)
		? value.commands
				.map(normalizeVerificationCommand)
				.filter((command): command is VerificationCommand => Boolean(command))
		: undefined;
	const lspDiagnostics = value.lspDiagnostics === true ? true : undefined;
	const maxRetries = typeof value.maxRetries === "number" && value.maxRetries >= 0 ? value.maxRetries : undefined;
	const onFailure =
		value.onFailure === "return_failure" || value.onFailure === "retry_once" || value.onFailure === "discard_patch"
			? value.onFailure
			: undefined;
	return { profile, mode, commands, lspDiagnostics, maxRetries, onFailure };
}

function mergeTaskVerifyConfig(
	base: TaskVerifyConfig | undefined,
	override: TaskVerifyConfig | undefined,
): TaskVerifyConfig {
	return {
		profile: override?.profile ?? base?.profile,
		mode: override?.mode ?? base?.mode,
		commands: override?.commands ?? base?.commands,
		lspDiagnostics: override?.lspDiagnostics ?? base?.lspDiagnostics,
		maxRetries: override?.maxRetries ?? base?.maxRetries,
		onFailure: override?.onFailure ?? base?.onFailure,
	};
}

function resolveTaskVerification(
	params: TaskParams,
	settings: ToolSession["settings"],
	isIsolated: boolean,
): ResolvedTaskVerification {
	const verify = "verify" in params ? params.verify : undefined;
	const verificationEnabled = settings.get("task.verification.enabled") === true;
	const requireForIsolated = settings.get("task.verification.requireForIsolated") === true;
	const defaultProfileValue = settings.get("task.verification.defaultProfile");
	const defaultProfile =
		typeof defaultProfileValue === "string" && defaultProfileValue.trim() ? defaultProfileValue.trim() : undefined;
	const maxRetriesValue = settings.get("task.verification.maxRetries");
	const maxRetries = typeof maxRetriesValue === "number" && maxRetriesValue >= 0 ? maxRetriesValue : 1;
	const notRequested: ResolvedTaskVerification = {
		requested: false,
		mode: "none",
		commands: [],
		maxRetries,
		onFailure: "return_failure",
	};
	if (!isIsolated) {
		if (verify !== undefined && verify !== false) {
			return {
				...notRequested,
				error: "Verification requires isolated task execution. Pass isolated: true or disable verify.",
			};
		}
		return notRequested;
	}
	if (verify === false) return notRequested;
	let profileName: string | undefined;
	let inlineConfig: TaskVerifyConfig | undefined;
	if (verify === undefined) {
		if (!(verificationEnabled && requireForIsolated)) return notRequested;
		profileName = defaultProfile;
	} else if (verify === true) {
		profileName = defaultProfile;
	} else if (typeof verify === "string") {
		profileName = verify.trim() || defaultProfile;
	} else {
		inlineConfig = normalizeTaskVerifyConfig(verify);
		profileName = inlineConfig?.profile ?? defaultProfile;
	}
	if (!profileName && !inlineConfig?.commands?.length) {
		return {
			...notRequested,
			error: "Verification requested but no verification profile or commands were provided.",
		};
	}
	const profileMapValue = settings.get("task.verification.profiles");
	const profileMap = isRecord(profileMapValue) ? profileMapValue : {};
	let profileConfig: TaskVerifyConfig | undefined;
	if (profileName) {
		profileConfig = normalizeTaskVerifyConfig(profileMap[profileName]);
		if (!profileConfig) {
			return {
				...notRequested,
				error: `Unknown or invalid verification profile "${profileName}".`,
			};
		}
	}
	const merged = mergeTaskVerifyConfig(profileConfig, inlineConfig);
	if (merged.mode === "none") return notRequested;
	if (merged.mode === "lsp" || merged.mode === "profile" || merged.lspDiagnostics === true) {
		return {
			...notRequested,
			error: "LSP-based task verification is not implemented yet. Use command checks for now.",
		};
	}
	const commands = merged.commands ?? [];
	if (commands.length === 0) {
		return {
			...notRequested,
			error: "Verification requires at least one command. Provide verify.commands or configure task.verification.profiles.",
		};
	}
	return {
		requested: true,
		profile: profileName,
		mode: "command",
		commands,
		maxRetries: merged.maxRetries ?? maxRetries,
		onFailure: merged.onFailure ?? "return_failure",
	};
}

function _getVerificationShellCommand(command: string): string[] {
	if (process.platform === "win32") {
		return ["cmd.exe", "/d", "/s", "/c", command];
	}
	return ["bash", "-lc", command];
}

function sanitizeArtifactToken(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "check";
}

function buildVerificationFailureMessage(verification: VerificationResult): string {
	const attempt = verification.attempts[verification.attempts.length - 1];
	if (!attempt) return "Verification failed.";
	const failedCommands = attempt.commandResults
		.filter(result => result.exitCode !== 0 && result.optional !== true)
		.map(result => result.name);
	if (failedCommands.length === 0) return attempt.error || "Verification failed.";
	return `Verification failed: ${failedCommands.join(", ")}`;
}

async function runVerificationAttempt(
	verification: ResolvedTaskVerification,
	options: {
		cwd: string;
		artifactsDir: string;
		taskId: string;
		signal?: AbortSignal;
		attemptNumber: number;
		onEvent?: (event: AgentSessionEvent) => void;
	},
): Promise<VerificationAttemptResult> {
	const startedAt = Date.now();
	const commandResults = [];
	let failed = false;
	options.onEvent?.({
		type: "subagent_verification_start",
		id: options.taskId,
		attempt: options.attemptNumber,
		profile: verification.profile,
	});
	for (let index = 0; index < verification.commands.length; index++) {
		const command = verification.commands[index];
		const cmdStart = Date.now();
		options.onEvent?.({
			type: "subagent_verification_command_start",
			id: options.taskId,
			attempt: options.attemptNumber,
			commandName: command.name,
		});
		const child = Bun.spawn(_getVerificationShellCommand(command.command), {
			cwd: options.cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal: options.signal,
			windowsHide: true,
		});
		let timedOut = false;
		let timeoutId: NodeJS.Timeout | undefined;
		if (command.timeoutMs) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				try {
					child.kill();
				} catch {}
			}, command.timeoutMs);
		}
		const [stdout, stderr, exitCode] = await Promise.all([
			child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
			child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
			child.exited,
		]);
		if (timeoutId) clearTimeout(timeoutId);
		const combinedOutput = `${stdout}${stderr}`.trim();
		const artifactName = sanitizeArtifactToken(command.name);
		const artifactPath = path.join(
			options.artifactsDir,
			`${options.taskId}.verify.a${options.attemptNumber}-${index + 1}-${artifactName}.log`,
		);
		if (combinedOutput) {
			await Bun.write(artifactPath, combinedOutput);
		}
		const outputPreview = combinedOutput ? combinedOutput.split("\n").slice(-20).join("\n").slice(-4000) : undefined;
		const cmdExitCode = exitCode ?? (timedOut ? 124 : 0);
		const cmdDurationMs = Date.now() - cmdStart;
		const cmdArtifactId = combinedOutput ? artifactPath : undefined;
		commandResults.push({
			name: command.name,
			command: command.command,
			exitCode: cmdExitCode,
			durationMs: cmdDurationMs,
			optional: command.optional,
			timedOut,
			artifactPath: cmdArtifactId,
			outputPreview,
		});
		options.onEvent?.({
			type: "subagent_verification_command_end",
			id: options.taskId,
			attempt: options.attemptNumber,
			commandName: command.name,
			exitCode: cmdExitCode,
			durationMs: cmdDurationMs,
			artifactId: cmdArtifactId,
		});
		if (cmdExitCode !== 0 && command.optional !== true) {
			failed = true;
		}
	}
	const status = (failed ? "failed" : "passed") as "failed" | "passed";
	options.onEvent?.({ type: "subagent_verification_end", id: options.taskId, attempt: options.attemptNumber, status });
	return {
		attempt: options.attemptNumber,
		status,
		startedAt,
		endedAt: Date.now(),
		commandResults,
		error: failed ? "One or more verification commands failed." : undefined,
	};
}

function buildRepairPrompt(task: string, attempt: VerificationAttemptResult, contextLineLimit: number): string {
	const failedCommands = attempt.commandResults
		.filter(r => r.exitCode !== 0 && r.optional !== true)
		.map(r => ({
			name: r.name,
			command: r.command,
			output: r.outputPreview
				? r.outputPreview.split("\n").slice(-contextLineLimit).join("\n")
				: "(no output captured)",
		}));
	const failureSummary = failedCommands.map(c => `- \`${c.name}\`: exited non-zero`).join("\n");
	return renderPromptTemplate(taskVerificationRepairTemplate, {
		task,
		failureSummary,
		failedCommands,
	});
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type { AgentDefinition, AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";
export { taskSchema } from "./types";

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	asyncEnabled: boolean,
	disabledAgents: string[],
): string {
	const filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	return renderPromptTemplate(taskDescriptionTemplate, {
		agents: filteredAgents,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		asyncEnabled,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Requires async initialization to discover available agents.
 * Use `TaskTool.create(session)` to instantiate.
 */
export class TaskTool implements AgentTool<TaskSchema, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly label = "Task";
	readonly strict = true;
	readonly parameters: TaskSchema;
	readonly renderCall = renderCall;
	readonly renderResult = renderResult;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			this.session.settings.get("async.enabled"),
			disabledAgents,
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
		isolationEnabled: boolean,
	) {
		this.parameters = isolationEnabled ? taskSchema : taskSchemaNoIsolation;
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const isolationMode = session.settings.get("task.isolation.mode");
		const { agents } = await discoverAgents(session.cwd);
		return new TaskTool(session, agents, isolationMode !== "none");
	}

	async execute(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const asyncEnabled = this.session.settings.get("async.enabled");
		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		if (!asyncEnabled || selectedAgent?.blocking === true) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}

		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is enabled but no async job manager is available." }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const taskItems = params.tasks ?? [];
		if (taskItems.length === 0) {
			return this.#executeSync(_toolCallId, params, signal, onUpdate);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
		const fallbackAgentSource =
			this.#discoveredAgents.find(agent => agent.name === params.agent)?.source ?? "bundled";
		const renderedTasks = taskItems.map(taskItem => renderTemplate(params.context, taskItem));
		const progressByTaskId = new Map<string, AgentProgress>();
		for (let index = 0; index < renderedTasks.length; index++) {
			const renderedTask = renderedTasks[index];
			progressByTaskId.set(renderedTask.id, {
				index,
				id: renderedTask.id,
				agent: params.agent,
				agentSource: fallbackAgentSource,
				status: "pending",
				task: renderedTask.task,
				assignment: renderedTask.assignment,
				description: renderedTask.description,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
			});
		}

		const startedJobs: Array<{ jobId: string; taskId: string }> = [];
		const failedSchedules: string[] = [];
		let completedJobs = 0;
		let failedJobs = 0;

		const getProgressSnapshot = (): AgentProgress[] => {
			return Array.from(progressByTaskId.values())
				.sort((a, b) => a.index - b.index)
				.map(progress => structuredClone(progress));
		};

		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: getProgressSnapshot(),
			async: { state, jobId, type: "task" },
		});

		const emitAsyncUpdate = (state: "running" | "completed" | "failed", text: string): void => {
			const primaryJobId = startedJobs[0]?.jobId ?? "task";
			onUpdate?.({
				content: [{ type: "text", text }],
				details: buildAsyncDetails(state, primaryJobId),
			});
		};

		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const semaphore = new Semaphore(maxConcurrency);

		for (let i = 0; i < taskItems.length; i++) {
			const taskItem = taskItems[i];
			if (signal?.aborted) {
				failedSchedules.push(`${taskItem.id}: cancelled before scheduling`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "aborted";
				}
				continue;
			}

			const uniqueId = uniqueIds[i];
			const singleParams: TaskParams = { ...params, tasks: [taskItem] };
			const label = uniqueId;
			try {
				const jobId = manager.register(
					"task",
					label,
					async ({ signal: runSignal, reportProgress }) => {
						const startedAt = Date.now();
						const progress = progressByTaskId.get(taskItem.id);
						await semaphore.acquire();
						if (runSignal.aborted) {
							semaphore.release();
							if (progress) {
								progress.status = "aborted";
							}
							throw new Error("Aborted before execution");
						}
						if (progress) {
							progress.status = "running";
						}
						await reportProgress(
							`Running background task ${taskItem.id}...`,
							buildAsyncDetails("running", startedJobs[0]?.jobId ?? label) as unknown as Record<string, unknown>,
						);
						try {
							const result = await this.#executeSync(_toolCallId, singleParams, runSignal, undefined, [
								uniqueId,
							]);
							const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
							const singleResult = result.details?.results[0];
							if (progress) {
								progress.status = singleResult?.aborted
									? "aborted"
									: (singleResult?.exitCode ?? 0) === 0
										? "completed"
										: "failed";
								progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
								progress.tokens = singleResult?.tokens ?? 0;
								progress.extractedToolData = singleResult?.extractedToolData;
							}
							completedJobs += 1;
							if (singleResult && ((singleResult.aborted ?? false) || singleResult.exitCode !== 0)) {
								failedJobs += 1;
							}
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete: ${completedJobs}/${taskItems.length} finished.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? (failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed") : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									failedJobs > 0 || failedSchedules.length > 0 ? "failed" : "completed",
									`Background task batch complete: ${completedJobs}/${taskItems.length} finished.`,
								);
							}
							return finalText;
						} catch (error) {
							if (progress) {
								progress.status = "failed";
								progress.durationMs = Math.max(0, Date.now() - startedAt);
							}
							completedJobs += 1;
							failedJobs += 1;
							const remaining = taskItems.length - completedJobs;
							const isDone = remaining === 0;
							await reportProgress(
								isDone
									? `Background task batch complete with failures: ${failedJobs} failed.`
									: `Background task batch progress: ${completedJobs}/${taskItems.length} finished (${remaining} running).`,
								buildAsyncDetails(
									isDone ? "failed" : "running",
									startedJobs[0]?.jobId ?? label,
								) as unknown as Record<string, unknown>,
							);
							if (isDone) {
								emitAsyncUpdate(
									"failed",
									`Background task batch complete with failures: ${failedJobs} failed.`,
								);
							}
							throw error;
						} finally {
							semaphore.release();
						}
					},
					{
						id: label,
						onProgress: (text, details) => {
							const progressDetails =
								(details as TaskToolDetails | undefined) ??
								buildAsyncDetails("running", startedJobs[0]?.jobId ?? label);
							onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
						},
					},
				);
				startedJobs.push({ jobId, taskId: taskItem.id });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${taskItem.id}: ${message}`);
				const progress = progressByTaskId.get(taskItem.id);
				if (progress) {
					progress.status = "failed";
				}
			}
		}

		if (startedJobs.length === 0) {
			const failureText = `Failed to start background task jobs: ${failedSchedules.join("; ")}`;
			return {
				content: [{ type: "text", text: failureText }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		emitAsyncUpdate(
			"running",
			`Launching ${startedJobs.length} background ${startedJobs.length === 1 ? "task" : "tasks"}...`,
		);

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} task${failedSchedules.length === 1 ? "" : "s"}.`
				: "";

		return {
			content: [
				{
					type: "text",
					text: `Started ${startedJobs.length} background task job${startedJobs.length === 1 ? "" : "s"} using ${params.agent}.${scheduleFailureSummary} Results will be delivered when complete.`,
				},
			],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: getProgressSnapshot(),
				async: { state: "running", jobId: startedJobs[0].jobId, type: "task" },
			},
		};
	}

	async #executeSync(
		_toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedIds?: string[],
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const { agent: agentName, context, schema: outputSchema } = params;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const taskDepth = this.session.taskDepth ?? 0;

		if (isolationMode === "none" && "isolated" in params) {
			return {
				content: [
					{
						type: "text",
						text: "Task isolation is disabled. Remove the isolated argument or set task.isolation.mode to 'worktree', 'fuse-overlay', or 'fuse-projfs'.",
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const resolvedVerification = resolveTaskVerification(params, this.session.settings, isIsolated);
		if (resolvedVerification.error) {
			return {
				content: [{ type: "text", text: resolvedVerification.error }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Validate agent exists
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Unknown agent "${agentName}". Available: ${available}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		// Check if agent is disabled in settings
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(agentName)) {
			const enabled = agents.filter(a => !disabledAgents.includes(a.name)).map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeTools = ["read", "grep", "find", "ls", "lsp", "web_search"];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;

		// Apply per-agent model override from settings (highest priority)
		const agentModelOverrides = this.session.settings.get("task.agentModelOverrides");
		const settingsModelOverride = agentModelOverrides[agentName];
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: settingsModelOverride,
			agentModel: effectiveAgent.model,
			settings: this.session.settings,
			activeModelPattern: this.session.getActiveModelString?.(),
			fallbackModelPattern: this.session.getModelString?.(),
		});
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		// Output schema priority: agent frontmatter > params > inherited from parent session
		const effectiveOutputSchema = effectiveAgent.output ?? outputSchema ?? this.session.outputSchema;

		// Handle empty or missing tasks
		if (!params.tasks || params.tasks.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No tasks provided. Use: { agent, context, tasks: [{id, description, args}, ...] }`,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		const tasks = params.tasks;
		const missingTaskIndexes: number[] = [];
		const idIndexes = new Map<string, number[]>();

		for (let i = 0; i < tasks.length; i++) {
			const id = tasks[i]?.id;
			if (typeof id !== "string" || id.trim() === "") {
				missingTaskIndexes.push(i);
				continue;
			}
			const normalizedId = id.toLowerCase();
			const indexes = idIndexes.get(normalizedId);
			if (indexes) {
				indexes.push(i);
			} else {
				idIndexes.set(normalizedId, [i]);
			}
		}

		const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
		for (const [normalizedId, indexes] of idIndexes.entries()) {
			if (indexes.length > 1) {
				duplicateIds.push({
					id: tasks[indexes[0]]?.id ?? normalizedId,
					indexes,
				});
			}
		}

		if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
			const problems: string[] = [];
			if (missingTaskIndexes.length > 0) {
				problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
			}
			if (duplicateIds.length > 0) {
				const details = duplicateIds.map(entry => `${entry.id} (indexes ${entry.indexes.join(", ")})`).join("; ");
				problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
			}
			return {
				content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: 0,
				},
			};
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Isolated task execution requires a git repository. ${message}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		}

		let effectiveIsolationMode = isolationMode;
		let isolationBackendWarning = "";
		try {
			const resolvedIsolation = await resolveIsolationBackendForTaskExecution(isolationMode, isIsolated, repoRoot);
			effectiveIsolationMode = resolvedIsolation.effectiveIsolationMode;
			isolationBackendWarning = resolvedIsolation.warning;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: message,
					},
				],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		// Initialize progress tracking
		const progressMap = new Map<number, AgentProgress>();

		// Update callback
		const emitProgress = () => {
			const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
			onUpdate?.({
				content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress,
				},
			});
		};

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Write parent conversation context for subagents
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });
			const compactContext = this.session.getCompactContext?.();
			let contextFilePath: string | undefined;
			if (compactContext) {
				contextFilePath = path.join(effectiveArtifactsDir, "context.md");
				await Bun.write(contextFilePath, compactContext);
			}

			// Build full prompts with context prepended
			// Allocate unique IDs across the session to prevent artifact collisions
			let uniqueIds: string[];
			if (preAllocatedIds && preAllocatedIds.length === tasks.length) {
				uniqueIds = preAllocatedIds;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				uniqueIds = await outputManager.allocateBatch(tasks.map(t => t.id));
			}
			const tasksWithUniqueIds = tasks.map((t, i) => ({ ...t, id: uniqueIds[i] }));

			// Build full prompts with context prepended
			const tasksWithContext = tasksWithUniqueIds.map(t => renderTemplate(context, t));
			const availableSkills = [...(this.session.skills ?? [])];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;

			// Initialize progress for all tasks
			for (let i = 0; i < tasksWithContext.length; i++) {
				const t = tasksWithContext[i];
				progressMap.set(i, {
					index: i,
					id: t.id,
					agent: agentName,
					agentSource: agent.source,
					status: "pending",
					task: t.task,
					assignment: t.assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 0,
					modelOverride,
					description: t.description,
				});
			}
			emitProgress();

			const runTask = async (task: (typeof tasksWithContext)[number], index: number) => {
				if (!isIsolated) {
					this.session.emitEvent?.({ type: "subagent_start", id: task.id, agent: agent.name, isolated: false });
					const nonIsolatedResult = await runSubprocess({
						cwd: this.session.cwd,
						agent,
						task: task.task,
						assignment: task.assignment,
						description: task.description,
						index,
						id: task.id,
						taskDepth,
						modelOverride,
						thinkingLevel: thinkingLevelOverride,
						outputSchema: effectiveOutputSchema,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						contextFile: contextFilePath,
						enableLsp: false,
						signal,
						eventBus: undefined,
						onProgress: progress => {
							progressMap.set(index, {
								...structuredClone(progress),
							});
							emitProgress();
						},
						authStorage: this.session.authStorage,
						modelRegistry: this.session.modelRegistry,
						searchDb: this.session.searchDb,
						settings: this.session.settings,
						mcpManager: this.session.mcpManager,
						contextFiles,
						skills: availableSkills,
						promptTemplates,
					});
					this.session.emitEvent?.({
						type: "subagent_end",
						id: task.id,
						agent: agent.name,
						exitCode: nonIsolatedResult.exitCode,
					});
					return nonIsolatedResult;
				}

				const taskStart = Date.now();
				let isolationDir: string | undefined;
				const isolatedResult = await (async () => {
					try {
						if (!repoRoot || !baseline) {
							throw new Error("Isolated task execution not initialized.");
						}
						const taskBaseline = structuredClone(baseline);

						if (effectiveIsolationMode === "fuse-overlay") {
							isolationDir = await ensureFuseOverlay(repoRoot, task.id);
						} else if (effectiveIsolationMode === "fuse-projfs") {
							isolationDir = await ensureProjfsOverlay(repoRoot, task.id);
						} else {
							isolationDir = await ensureWorktree(repoRoot, task.id);
							await applyBaseline(isolationDir, taskBaseline);
						}

						const captureTaskPatch = async (baseResult: SingleResult): Promise<SingleResult> => {
							if (!isolationDir) throw new Error("Isolated task execution not initialized.");
							const delta = await captureDeltaPatch(isolationDir, taskBaseline);
							const patchPath = path.join(effectiveArtifactsDir, `${task.id}.patch`);
							await Bun.write(patchPath, delta.rootPatch);
							return {
								...baseResult,
								patchPath,
								nestedPatches: delta.nestedPatches,
							};
						};
						this.session.emitEvent?.({ type: "subagent_start", id: task.id, agent: agent.name, isolated: true });
						let result = await runSubprocess({
							cwd: this.session.cwd,
							worktree: isolationDir,
							agent,
							task: task.task,
							assignment: task.assignment,
							description: task.description,
							index,
							id: task.id,
							taskDepth,
							modelOverride,
							thinkingLevel: thinkingLevelOverride,
							outputSchema: effectiveOutputSchema,
							sessionFile,
							persistArtifacts: !!artifactsDir,
							artifactsDir: effectiveArtifactsDir,
							contextFile: contextFilePath,
							enableLsp: false,
							signal,
							eventBus: undefined,
							onProgress: progress => {
								progressMap.set(index, {
									...structuredClone(progress),
								});
								emitProgress();
							},
							authStorage: this.session.authStorage,
							modelRegistry: this.session.modelRegistry,
							searchDb: this.session.searchDb,
							settings: this.session.settings,
							mcpManager: this.session.mcpManager,
							contextFiles,
							skills: availableSkills,
							promptTemplates,
						});
						if (resolvedVerification.requested) {
							const contextLineLimit = Number(
								this.session.settings.get("task.verification.failureContextLineLimit") ?? 200,
							);
							if (result.exitCode === 0) {
								const onFailurePolicy = resolvedVerification.onFailure;
								const attempt1 = await runVerificationAttempt(resolvedVerification, {
									cwd: isolationDir,
									artifactsDir: effectiveArtifactsDir,
									taskId: task.id,
									signal,
									attemptNumber: 1,
									onEvent: this.session.emitEvent,
								});
								if (attempt1.status === "passed") {
									result = {
										...result,
										verification: {
											requested: true,
											profile: resolvedVerification.profile,
											mode: resolvedVerification.mode,
											status: "passed",
											attempts: [attempt1],
											retriesUsed: 0,
											onFailure: resolvedVerification.onFailure,
										},
									};
								} else if (
									resolvedVerification.onFailure === "retry_once" &&
									resolvedVerification.maxRetries >= 1
								) {
									const repairTask = buildRepairPrompt(task.task, attempt1, contextLineLimit);
									const repairResult = await runSubprocess({
										cwd: this.session.cwd,
										worktree: isolationDir,
										agent,
										task: repairTask,
										assignment: task.assignment,
										description: task.description,
										index,
										id: `${task.id}-repair`,
										taskDepth,
										modelOverride,
										thinkingLevel: thinkingLevelOverride,
										outputSchema: effectiveOutputSchema,
										sessionFile,
										persistArtifacts: !!artifactsDir,
										artifactsDir: effectiveArtifactsDir,
										contextFile: contextFilePath,
										enableLsp: false,
										signal,
										eventBus: undefined,
										onProgress: progress => {
											progressMap.set(index, { ...structuredClone(progress) });
											emitProgress();
										},
										authStorage: this.session.authStorage,
										modelRegistry: this.session.modelRegistry,
										searchDb: this.session.searchDb,
										settings: this.session.settings,
										mcpManager: this.session.mcpManager,
										contextFiles,
										skills: availableSkills,
										promptTemplates,
									});
									if (repairResult.exitCode === 0) {
										const attempt2 = await runVerificationAttempt(resolvedVerification, {
											cwd: isolationDir,
											artifactsDir: effectiveArtifactsDir,
											taskId: task.id,
											signal,
											attemptNumber: 2,
											onEvent: this.session.emitEvent,
										});
										result = {
											...repairResult,
											verification: {
												requested: true,
												profile: resolvedVerification.profile,
												mode: resolvedVerification.mode,
												status: attempt2.status === "passed" ? "retried_passed" : "failed",
												attempts: [attempt1, attempt2],
												retriesUsed: 1,
												onFailure: resolvedVerification.onFailure,
											},
										};
										if (attempt2.status === "passed") {
											// repair succeeded — fall through to normal patch/branch capture
										} else {
											const verificationError = buildVerificationFailureMessage(result.verification!);
											const failedResult: SingleResult = {
												...result,
												exitCode: 1,
												stderr: verificationError,
												error: verificationError,
											};
											if (onFailurePolicy === "discard_patch") return failedResult;
											try {
												return await captureTaskPatch(failedResult);
											} catch (patchErr) {
												const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
												return { ...failedResult, error: `Patch capture failed: ${msg}` };
											}
										}
									} else {
										// repair subagent itself failed — keep original verification result
										result = {
											...result,
											verification: {
												requested: true,
												profile: resolvedVerification.profile,
												mode: resolvedVerification.mode,
												status: "failed",
												attempts: [attempt1],
												retriesUsed: 1,
												onFailure: resolvedVerification.onFailure,
											},
										};
										const verificationError = buildVerificationFailureMessage(result.verification!);
										const failedResult: SingleResult = {
											...result,
											exitCode: 1,
											stderr: verificationError,
											error: verificationError,
										};
										if (onFailurePolicy === "discard_patch") return failedResult;
										try {
											return await captureTaskPatch(failedResult);
										} catch (patchErr) {
											const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
											return { ...failedResult, error: `Patch capture failed: ${msg}` };
										}
									}
								} else {
									// return_failure or discard_patch on first attempt
									const verificationError = buildVerificationFailureMessage({
										requested: true,
										profile: resolvedVerification.profile,
										mode: resolvedVerification.mode,
										status: "failed",
										attempts: [attempt1],
										retriesUsed: 0,
										onFailure: resolvedVerification.onFailure,
									});
									result = {
										...result,
										verification: {
											requested: true,
											profile: resolvedVerification.profile,
											mode: resolvedVerification.mode,
											status: "failed",
											attempts: [attempt1],
											retriesUsed: 0,
											onFailure: resolvedVerification.onFailure,
										},
									};
									const failedResult: SingleResult = {
										...result,
										exitCode: 1,
										stderr: verificationError,
										error: verificationError,
									};
									if (onFailurePolicy === "discard_patch") return failedResult;
									try {
										return await captureTaskPatch(failedResult);
									} catch (patchErr) {
										const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
										return { ...failedResult, error: `Patch capture failed: ${msg}` };
									}
								}
							} else {
								// subagent failed before verification could run
								result = {
									...result,
									verification: {
										requested: true,
										profile: resolvedVerification.profile,
										mode: resolvedVerification.mode,
										status: "skipped",
										attempts: [],
										retriesUsed: 0,
										onFailure: resolvedVerification.onFailure,
									},
								};
							}
						}
						if (mergeMode === "branch" && result.exitCode === 0) {
							try {
								const commitMsg =
									commitStyle === "ai" && this.session.modelRegistry
										? async (diff: string) => {
												return generateCommitMessage(
													diff,
													this.session.modelRegistry!,
													this.session.settings,
													this.session.getSessionId?.() ?? undefined,
												);
											}
										: undefined;
								const commitResult = await commitToBranch(
									isolationDir,
									taskBaseline,
									task.id,
									task.description,
									commitMsg,
								);
								return {
									...result,
									branchName: commitResult?.branchName,
									nestedPatches: commitResult?.nestedPatches,
								};
							} catch (mergeErr) {
								const branchName = `omp/task/${task.id}`;
								await git.branch.tryDelete(repoRoot, branchName);
								const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
								return { ...result, error: `Merge failed: ${msg}` };
							}
						}
						if (result.exitCode === 0) {
							try {
								return await captureTaskPatch(result);
							} catch (patchErr) {
								const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
								return { ...result, error: `Patch capture failed: ${msg}` };
							}
						}
						return result;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							index,
							id: task.id,
							agent: agent.name,
							agentSource: agent.source,
							task: task.task,
							assignment: task.assignment,
							description: task.description,
							exitCode: 1,
							output: "",
							stderr: message,
							truncated: false,
							durationMs: Date.now() - taskStart,
							tokens: 0,
							modelOverride,
							error: message,
						};
					} finally {
						if (isolationDir) {
							if (effectiveIsolationMode === "fuse-overlay") {
								await cleanupFuseOverlay(isolationDir);
							} else if (effectiveIsolationMode === "fuse-projfs") {
								await cleanupProjfsOverlay(isolationDir);
							} else {
								await cleanupWorktree(isolationDir);
							}
						}
					}
				})();
				this.session.emitEvent?.({
					type: "subagent_end",
					id: task.id,
					agent: agent.name,
					exitCode: isolatedResult.exitCode,
					verification: isolatedResult.verification,
				});
				return isolatedResult;
			};

			// Execute in parallel with concurrency limit
			const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
				tasksWithContext,
				maxConcurrency,
				runTask,
				signal,
			);

			// Fill in skipped tasks (undefined entries from abort) with placeholder results
			const results: SingleResult[] = partialResults.map((result, index) => {
				if (result !== undefined) {
					return result;
				}
				const task = tasksWithContext[index]!;
				return {
					index,
					id: task.id,
					agent: agentName,
					agentSource: agent.source,
					task: task.task,
					assignment: task.assignment,
					description: task.description,
					exitCode: 1,
					output: "",
					stderr: "Skipped (cancelled before start)",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					modelOverride,
					error: "Cancelled before start",
					aborted: true,
					abortReason: "Cancelled before start",
				};
			});

			// Aggregate usage from executor results (already accumulated incrementally)
			const aggregatedUsage = createUsageTotals();
			let hasAggregatedUsage = false;
			for (const result of results) {
				if (result.usage) {
					addUsageTotals(aggregatedUsage, result.usage);
					hasAggregatedUsage = true;
				}
			}

			// Collect output paths (artifacts already written by executor in real-time)
			const outputPaths: string[] = [];
			const patchPaths: string[] = [];
			for (const result of results) {
				if (result.outputPath) {
					outputPaths.push(result.outputPath);
				}
				if (result.patchPath) {
					patchPaths.push(result.patchPath);
				}
			}

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let mergedBranchesForNestedPatches: Set<string> | null = null;
			if (isIsolated && repoRoot) {
				if (mergeMode === "branch") {
					// Branch mode: merge task branches sequentially
					const branchEntries = results
						.filter(r => r.branchName && r.exitCode === 0 && !r.aborted)
						.map(r => ({ branchName: r.branchName!, taskId: r.id, description: r.description }));

					if (branchEntries.length === 0) {
						changesApplied = true;
					} else {
						const mergeResult = await mergeTaskBranches(repoRoot, branchEntries);
						mergedBranchesForNestedPatches = new Set(mergeResult.merged);
						changesApplied = mergeResult.failed.length === 0;

						if (changesApplied) {
							mergeSummary = `\n\nMerged ${mergeResult.merged.length} branch${mergeResult.merged.length === 1 ? "" : "es"}: ${mergeResult.merged.join(", ")}`;
						} else {
							const mergedPart =
								mergeResult.merged.length > 0 ? `Merged: ${mergeResult.merged.join(", ")}.\n` : "";
							const failedPart = `Failed: ${mergeResult.failed.join(", ")}.`;
							const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
							mergeSummary = `\n\n<system-notification>Branch merge failed. ${mergedPart}${failedPart}${conflictPart}\nUnmerged branches remain for manual resolution.</system-notification>`;
						}
					}

					// Clean up merged branches (keep failed ones for manual resolution)
					const allBranches = branchEntries.map(b => b.branchName);
					if (changesApplied) {
						await cleanupTaskBranches(repoRoot, allBranches);
					}
				} else {
					// Patch mode: combine and apply patches
					const patchesInOrder = results.map(result => result.patchPath).filter(Boolean) as string[];
					const missingPatch = results.some(result => !result.patchPath);
					if (missingPatch) {
						changesApplied = false;
					} else {
						const patchStats = await Promise.all(
							patchesInOrder.map(async patchPath => ({
								patchPath,
								size: (await fs.stat(patchPath)).size,
							})),
						);
						const nonEmptyPatches = patchStats.filter(patch => patch.size > 0).map(patch => patch.patchPath);
						if (nonEmptyPatches.length === 0) {
							changesApplied = true;
						} else {
							const patchTexts = await Promise.all(
								nonEmptyPatches.map(async patchPath => Bun.file(patchPath).text()),
							);
							const combinedPatch = patchTexts.map(text => (text.endsWith("\n") ? text : `${text}\n`)).join("");
							if (!combinedPatch.trim()) {
								changesApplied = true;
							} else {
								changesApplied = await git.patch.canApplyText(repoRoot, combinedPatch);
								if (changesApplied) {
									try {
										await git.patch.applyText(repoRoot, combinedPatch);
									} catch {
										changesApplied = false;
									}
								}
							}
						}
					}

					if (changesApplied) {
						mergeSummary = "\n\nApplied patches: yes";
					} else {
						const notification =
							"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
						const patchList =
							patchPaths.length > 0
								? `\n\nPatch artifacts:\n${patchPaths.map(patch => `- ${patch}`).join("\n")}`
								: "";
						mergeSummary = `\n\n${notification}${patchList}`;
					}
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && (mergeMode === "branch" || changesApplied !== false)) {
				const allNestedPatches = results
					.filter(r => {
						if (!r.nestedPatches || r.nestedPatches.length === 0 || r.exitCode !== 0 || r.aborted) {
							return false;
						}
						if (mergeMode !== "branch") {
							return true;
						}
						if (!r.branchName || !mergedBranchesForNestedPatches) {
							return false;
						}
						return mergedBranchesForNestedPatches.has(r.branchName);
					})
					.flatMap(r => r.nestedPatches!);
				if (allNestedPatches.length > 0) {
					try {
						const commitMsg =
							commitStyle === "ai" && this.session.modelRegistry
								? async (diff: string) => {
										return generateCommitMessage(
											diff,
											this.session.modelRegistry!,
											this.session.settings,
											this.session.getSessionId?.() ?? undefined,
										);
									}
								: undefined;
						await applyNestedPatches(repoRoot, allNestedPatches, commitMsg);
					} catch {
						// Nested patch failures are non-fatal to the parent merge
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
					}
				}
			}

			// Build final output - match plugin format
			const successCount = results.filter(r => r.exitCode === 0 && !r.error).length;
			const cancelledCount = results.filter(r => r.aborted).length;
			const totalDuration = Date.now() - startTime;

			const summaries = results.map(r => {
				const status = r.aborted
					? "cancelled"
					: r.exitCode === 0 && r.error
						? "merge failed"
						: r.exitCode === 0
							? "completed"
							: `failed (exit ${r.exitCode})`;
				const output = r.output.trim() || r.stderr.trim() || "(no output)";
				const outputCharCount = r.outputMeta?.charCount ?? output.length;
				const fullOutputThreshold = 5000;
				let preview = output;
				let truncated = false;
				if (outputCharCount > fullOutputThreshold) {
					const slice = output.slice(0, fullOutputThreshold);
					const lastNewline = slice.lastIndexOf("\n");
					preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
					truncated = true;
				}
				return {
					agent: r.agent,
					status,
					id: r.id,
					preview,
					truncated,
					meta: r.outputMeta
						? {
								lineCount: r.outputMeta.lineCount,
								charSize: formatBytes(r.outputMeta.charCount),
							}
						: undefined,
				};
			});

			const outputIds = results.filter(r => !r.aborted || r.output.trim()).map(r => `agent://${r.id}`);
			const backendSummaryPrefix = isolationBackendWarning ? `\n\n${isolationBackendWarning}` : "";
			const summary = renderPromptTemplate(taskSummaryTemplate, {
				successCount,
				totalCount: results.length,
				cancelledCount,
				hasCancelledNote: aborted && cancelledCount > 0,
				duration: formatDuration(totalDuration),
				summaries,
				outputIds,
				agentName,
				mergeSummary: `${backendSummaryPrefix}${mergeSummary}`,
			});

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return {
				content: [{ type: "text", text: summary }],
				details: {
					projectAgentsDir,
					results: results,
					totalDurationMs: totalDuration,
					usage: hasAggregatedUsage ? aggregatedUsage : undefined,
					outputPaths,
				},
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: {
					projectAgentsDir,
					results: [],
					totalDurationMs: Date.now() - startTime,
				},
			};
		}
	}
}
