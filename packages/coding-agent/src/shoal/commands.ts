/**
 * `/team` slash command + LLM tools — Shoal-backed multi-session team orchestration.
 *
 * Use `/team` (or `shoal_team_run`) when work requires:
 *   - separate git worktrees per agent
 *   - independently inspectable sessions
 *   - long-running or supervised execution
 *   - durable handoffs, journals, or cross-session approvals
 *
 * Use the `task` tool instead when:
 *   - delegation stays inside the current session
 *   - separate worktrees are not needed
 *   - work is short-lived (planning, analysis, parallel exploration)
 *
 * Slash commands:
 *   /team run <file.yaml>       Parse and execute a team.yaml definition
 *   /team status                Show the last known progress widget
 *   /team abort                 Abort an in-progress run
 *   /team approve <id> [reason] Approve a pending action request
 *   /team deny <id> [reason]    Deny a pending action request
 *   /team help                  Show usage
 *
 * LLM tools (registered via pi.registerTool):
 *   shoal_team_run           Start a team run from a YAML file path
 *   shoal_team_status        Query the active run status
 *   shoal_team_abort         Abort the active run
 *   shoal_request_action     Submit an action request for human approval
 *
 * All Shoal interactions go through ShoalMcpBridge (session-lifecycle.ts).
 * See PISCES_SHOAL_EXECUTION_MODEL.md for the full decision guide.
 */

import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensibility/extensions/types";
import { type OrchestrationProgress, renderTeamProgress, ShoalOrchestrator } from "./orchestrator";
import { ShoalMcpBridge } from "./session-lifecycle";
import {
	buildTeamDependencyGraph,
	buildTeamExecutionWaves,
	detectTeamCycles,
	parseTeamYaml,
	type TeamDefinition,
	validateTeamDefinition,
} from "./team-schema";

// ── Module-level run state (one active run per session) ──────────────────────

interface ActiveRun {
	orchestrator: ShoalOrchestrator;
	bridge: ShoalMcpBridge;
	def: TeamDefinition;
	abortController: AbortController;
	widgetKey: string;
}

let activeRun: ActiveRun | null = null;

// ── Extension factory ────────────────────────────────────────────────────────

export function registerTeamCommand(pi: ExtensionAPI): void {
	pi.setLabel("Team Orchestrator");

	pi.registerCommand("team", {
		description: "Shoal multi-agent team orchestration",
		getArgumentCompletions: prefix => {
			const subs = ["run", "status", "abort", "approve", "deny", "help"];
			if (!prefix) return subs.map(s => ({ label: s, value: s }));
			return subs.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] ?? "help";

			switch (sub) {
				case "run":
					await handleRun(parts[1], ctx);
					return;
				case "status":
					handleStatus(ctx);
					return;
				case "abort":
					handleAbort(ctx);
					return;
				case "approve":
					await handleApprove(parts[1], parts.slice(2).join(" "), ctx);
					return;
				case "deny":
					await handleDeny(parts[1], parts.slice(2).join(" "), ctx);
					return;
				default:
					showHelp(ctx);
			}
		},
	});

	// ── LLM-callable tools ─────────────────────────────────────────────────

	const TeamRunParams = Type.Object({
		file: Type.String({
			description:
				"Path to the team.yaml file (absolute or relative to cwd). " +
				"The YAML must have a top-level 'team' key with 'name', 'agents', and optionally 'path' and 'workspace'.",
		}),
	});

	pi.registerTool({
		name: "shoal_team_run",
		label: "Team Run",
		description:
			"Start a Shoal multi-agent team run from a YAML definition file. " +
			"Each agent runs in its own isolated Shoal session (separate worktree, " +
			"tmux pane, and context). Use this when agents need git isolation, " +
			"long-running supervision, or durable handoffs. " +
			"For short-lived parallel work inside the current session, use the task tool instead. " +
			"Spawns sessions in dependency order (waves) and shows a live progress widget. " +
			"Returns immediately after starting — " +
			"use shoal_team_status to check progress or shoal_team_abort to cancel.",
		parameters: TeamRunParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const msg = await handleRun(params.file, ctx);
			return { content: [{ type: "text", text: msg }] };
		},
	});

	const TeamStatusParams = Type.Object({});

	pi.registerTool({
		name: "shoal_team_status",
		label: "Team Status",
		description:
			"Return the current status of the active Shoal team run. " +
			"Shows each agent's state (pending/running/completed/failed) and elapsed time. " +
			"Returns 'No active team run.' if nothing is running.",
		parameters: TeamStatusParams,
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			return { content: [{ type: "text", text: getStatusText() }] };
		},
	});

	const TeamAbortParams = Type.Object({});

	pi.registerTool({
		name: "shoal_team_abort",
		label: "Team Abort",
		description: "Abort the active Shoal team run. No-op if nothing is running.",
		parameters: TeamAbortParams,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const msg = doAbort();
			if (msg) ctx.ui.notify(msg, "warning");
			return { content: [{ type: "text", text: msg ?? "No active team run." }] };
		},
	});

	const RequestActionParams = Type.Object({
		requester_session: Type.String({
			description: "Name of the session submitting the request (use your session name or 'pisces').",
		}),
		action_type: Type.String({
			description: "Short identifier for the action, e.g. 'merge_branch', 'run_deploy', 'edit_protected_path'.",
		}),
		payload_json: Type.String({ description: "JSON string with context needed to evaluate or execute the action." }),
		correlation_id: Type.Optional(
			Type.String({ description: "Workflow correlation ID (wf_...) to link this request to a team run." }),
		),
		target_role: Type.Optional(
			Type.String({ description: "Role that should approve (e.g. 'supervisor'). Omit to allow any approver." }),
		),
	});

	pi.registerTool({
		name: "shoal_request_action",
		label: "Request Action",
		description:
			"Submit an action request to the Shoal action bus for human approval. " +
			"Use before performing a destructive or privileged operation — the request will " +
			"appear in the active team run progress widget and can be resolved with " +
			"/team approve <id> or /team deny <id>. " +
			"Returns the action ID; include it in your journal or handoff notes.",
		parameters: RequestActionParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const bridge = new ShoalMcpBridge();
			try {
				await bridge.connect();
				const result = await bridge.requestAction({
					requesterSession: params.requester_session,
					actionType: params.action_type,
					payloadJson: params.payload_json,
					correlationId: params.correlation_id,
					targetRole: params.target_role,
				});
				const msg = `Action requested: id=${result.id} type=${result.action_type} status=${result.status}`;
				ctx.ui.notify(msg, "info");
				return { content: [{ type: "text", text: msg }] };
			} catch (err) {
				const msg = `Failed to submit action request: ${err instanceof Error ? err.message : String(err)}`;
				ctx.ui.notify(msg, "error");
				return { content: [{ type: "text", text: msg }] };
			} finally {
				await bridge.disconnect().catch(() => {});
			}
		},
	});
}

// ── /team run ────────────────────────────────────────────────────────────────

/** Start a team run. Returns a status string (used by both slash command and tool). */
async function handleRun(yamlPath: string | undefined, ctx: ExtensionContext): Promise<string> {
	if (!yamlPath) {
		const msg = "Usage: /team run <path/to/team.yaml>";
		ctx.ui.notify(msg, "error");
		return msg;
	}

	if (activeRun) {
		const msg = "A team run is already in progress. Use /team abort to stop it first.";
		ctx.ui.notify(msg, "error");
		return msg;
	}

	const resolvedPath = path.isAbsolute(yamlPath) ? yamlPath : path.resolve(ctx.cwd, yamlPath);

	let content: string;
	try {
		content = await Bun.file(resolvedPath).text();
	} catch {
		const msg = `Cannot read file: ${resolvedPath}`;
		ctx.ui.notify(msg, "error");
		return msg;
	}

	let def: TeamDefinition;
	try {
		def = parseTeamYaml(content);
	} catch (err) {
		const msg = `YAML error: ${err instanceof Error ? err.message : String(err)}`;
		ctx.ui.notify(msg, "error");
		return msg;
	}

	const validationErrors = validateTeamDefinition(def);
	if (validationErrors.length > 0) {
		const msg = `Validation errors:\n${validationErrors.map(e => `  - ${e}`).join("\n")}`;
		ctx.ui.notify(msg, "error");
		return msg;
	}

	// Quick DAG check before connecting to Shoal
	const deps = buildTeamDependencyGraph(def);
	const cycles = detectTeamCycles(deps);
	if (cycles) {
		const msg = `Cycle detected in dependencies: [${cycles.join(", ")}]`;
		ctx.ui.notify(msg, "error");
		return msg;
	}
	const waves = buildTeamExecutionWaves(deps);

	const abortController = new AbortController();
	const bridge = new ShoalMcpBridge(abortController.signal);
	const orchestrator = new ShoalOrchestrator(bridge);
	const widgetKey = `team-${def.name}`;

	activeRun = { orchestrator, bridge, def, abortController, widgetKey };

	try {
		await bridge.connect();
	} catch (err) {
		const msg =
			`Cannot connect to shoal-mcp-server: ${err instanceof Error ? err.message : String(err)}\n` +
			"Make sure shoal is installed and 'shoal-mcp-server' is on your PATH.";
		ctx.ui.notify(msg, "error");
		activeRun = null;
		return msg;
	}

	// Resolve def.path relative to the YAML file's directory
	const defPath = def.path === "." ? path.dirname(resolvedPath) : def.path;
	const resolvedDef: TeamDefinition = { ...def, path: defPath };

	const startMsg = `Team '${def.name}' started: ${def.agents.size} agent(s), ${waves.length} wave(s)`;
	ctx.ui.notify(startMsg, "info");

	// Run orchestration (non-blocking — fire and forget)
	orchestrator
		.run(resolvedDef, {
			signal: abortController.signal,
			onProgress: (progress: OrchestrationProgress) => {
				ctx.ui.setWidget(widgetKey, renderTeamProgress(progress));
			},
		})
		.then(result => {
			ctx.ui.setWidget(widgetKey, undefined);
			const elapsed = Math.round(result.elapsedMs / 1_000);
			const wf = result.correlationId;
			if (result.status === "completed") {
				ctx.ui.notify(`Team '${def.name}' [${wf}] completed in ${elapsed}s`, "info");
			} else if (result.status === "aborted") {
				ctx.ui.notify(`Team '${def.name}' [${wf}] aborted after ${elapsed}s`, "warning");
			} else {
				const errSummary = result.errors.length > 0 ? `\n${result.errors.map(e => `  - ${e}`).join("\n")}` : "";
				ctx.ui.notify(`Team '${def.name}' [${wf}] failed after ${elapsed}s${errSummary}`, "error");
			}
		})
		.catch(err => {
			ctx.ui.setWidget(widgetKey, undefined);
			ctx.ui.notify(`Team '${def.name}' crashed: ${err instanceof Error ? err.message : String(err)}`, "error");
		})
		.finally(async () => {
			await bridge.disconnect().catch(() => {});
			activeRun = null;
		});

	return startMsg;
}

// ── /team status ──────────────────────────────────────────────────────────────

function getStatusText(): string {
	if (!activeRun) return "No active team run.";
	const { def, widgetKey: _k } = activeRun;
	const lines: string[] = [`Active team: '${def.name}'  (${def.agents.size} agents)`];
	for (const [name, agent] of def.agents) {
		lines.push(`  ${name} → template: ${agent.template}`);
	}
	return lines.join("\n");
}

function handleStatus(ctx: ExtensionContext): void {
	ctx.ui.notify(getStatusText(), activeRun ? "info" : "info");
}

// ── /team abort ───────────────────────────────────────────────────────────────

/** Returns an abort message, or undefined if nothing was running. */
function doAbort(): string | undefined {
	if (!activeRun) return undefined;
	const name = activeRun.def.name;
	activeRun.abortController.abort();
	activeRun.orchestrator.abort();
	return `Aborting team '${name}'…`;
}

function handleAbort(ctx: ExtensionContext): void {
	const msg = doAbort();
	ctx.ui.notify(msg ?? "No active team run.", msg ? "warning" : "info");
}

// ── /team approve / deny ──────────────────────────────────────────────────────

async function handleApprove(idArg: string | undefined, reason: string, ctx: ExtensionContext): Promise<void> {
	const actionId = Number(idArg);
	if (!idArg || !Number.isInteger(actionId) || actionId <= 0) {
		ctx.ui.notify("Usage: /team approve <id> [reason]", "error");
		return;
	}
	const bridge = new ShoalMcpBridge();
	try {
		await bridge.connect();
		await bridge.approveAction(actionId, "pisces", reason || undefined);
		ctx.ui.notify(`Action ${actionId} approved.`, "info");
	} catch (err) {
		ctx.ui.notify(`Approve failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await bridge.disconnect().catch(() => {});
	}
}

async function handleDeny(idArg: string | undefined, reason: string, ctx: ExtensionContext): Promise<void> {
	const actionId = Number(idArg);
	if (!idArg || !Number.isInteger(actionId) || actionId <= 0) {
		ctx.ui.notify("Usage: /team deny <id> [reason]", "error");
		return;
	}
	const bridge = new ShoalMcpBridge();
	try {
		await bridge.connect();
		await bridge.denyAction(actionId, "pisces", reason || undefined);
		ctx.ui.notify(`Action ${actionId} denied.`, "warning");
	} catch (err) {
		ctx.ui.notify(`Deny failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await bridge.disconnect().catch(() => {});
	}
}

// ── /team help ────────────────────────────────────────────────────────────────

function showHelp(ctx: ExtensionContext): void {
	ctx.ui.notify(
		[
			"Team — Shoal multi-session team orchestrator",
			"",
			"When to use /team (vs the task tool):",
			"  Use /team when agents need separate git worktrees, independently",
			"  inspectable sessions, long-running supervision, or durable handoffs.",
			"  Use task for short-lived parallel work inside the current session.",
			"",
			"Slash commands:",
			"  /team run <file.yaml>       Execute a team.yaml definition",
			"  /team status                Show active run status",
			"  /team abort                 Abort the active run",
			"  /team approve <id> [reason] Approve a pending action request",
			"  /team deny <id> [reason]    Deny a pending action request",
			"  /team help                  Show this help",
			"",
			"LLM tools: shoal_team_run, shoal_team_status, shoal_team_abort, shoal_request_action",
			"",
			"team.yaml format:",
			"  team:",
			"    name: my-feature",
			"    path: '.'",
			"    workspace: ./workspace",
			"    agents:",
			"      planner:",
			"        template: pisces-planner",
			"        prompt: |",
			"          Plan the feature. Write to workspace/plan.md.",
			"          Call mark_complete when done.",
			"      engineer:",
			"        template: pisces-engineer",
			"        worktree: true",
			"        branch: true",
			"        waits_for: [planner]",
			"        prompt: |",
			"          Read workspace/plan.md. Implement it.",
			"          Call mark_complete when done.",
		].join("\n"),
		"info",
	);
}
