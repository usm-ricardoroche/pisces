/**
 * Team YAML schema — declarative multi-agent Shoal team definitions.
 *
 * Top-level key is `team`. Each agent entry maps to a Shoal template and
 * carries its own prompt, dependency edges, and worktree settings.
 *
 * Example:
 *   team:
 *     name: auth-feature
 *     path: "."
 *     workspace: ./workspace
 *     agents:
 *       planner:
 *         template: pisces-planner
 *         prompt: |
 *           Plan the OAuth2 implementation. Write to workspace/plan.md.
 *           Call mark_complete when done.
 *       backend-dev:
 *         template: pisces-backend-engineer
 *         worktree: true
 *         branch: true
 *         waits_for: [planner]
 *         prompt: |
 *           Read workspace/plan.md. Implement the backend changes.
 *           Call mark_complete when done.
 */

import { YAML } from "bun";

// ── Raw YAML shapes (snake_case, optional fields) ────────────────────────────

interface RawTeamAgentConfig {
	template: string;
	prompt: string;
	worktree?: boolean;
	branch?: boolean;
	waits_for?: string[];
}

interface RawTeamConfig {
	name: string;
	path?: string;
	workspace?: string;
	expertise_dir?: string;
	agents: Record<string, RawTeamAgentConfig>;
}

// ── Normalized types (camelCase, defaults applied) ───────────────────────────

export interface TeamAgent {
	name: string;
	template: string;
	prompt: string;
	worktree: boolean;
	/** Only meaningful when worktree is true. */
	branch: boolean;
	waitsFor: string[];
}

export interface TeamDefinition {
	name: string;
	/** Absolute or relative path to the project root. Defaults to ".". */
	path: string;
	/** Shared output directory agents write results to. */
	workspace: string;
	/** Optional directory where expertise files are maintained. */
	expertiseDir?: string;
	agents: Map<string, TeamAgent>;
	/** Preserves YAML declaration order for deterministic wave building. */
	agentOrder: string[];
}

// ── Validation ───────────────────────────────────────────────────────────────

const VALID_NAME = /^[a-zA-Z0-9._-]+$/;

export function parseTeamYaml(content: string): TeamDefinition {
	const raw = YAML.parse(content) as { team?: RawTeamConfig } | null;
	if (!raw?.team) {
		throw new Error("YAML must have a top-level 'team' key");
	}
	const team = raw.team;

	if (!team.name || typeof team.name !== "string") {
		throw new Error("team.name is required and must be a string");
	}
	if (!VALID_NAME.test(team.name)) {
		throw new Error("team.name may only contain letters, numbers, dot, underscore, and dash");
	}

	if (!team.agents || typeof team.agents !== "object" || Object.keys(team.agents).length === 0) {
		throw new Error("team.agents must contain at least one agent");
	}

	const agentOrder: string[] = [];
	const agents = new Map<string, TeamAgent>();

	for (const [agentName, config] of Object.entries(team.agents)) {
		if (!VALID_NAME.test(agentName)) {
			throw new Error(`Agent name '${agentName}' may only contain letters, numbers, dot, underscore, and dash`);
		}
		if (!config.template || typeof config.template !== "string") {
			throw new Error(`Agent '${agentName}': 'template' is required`);
		}
		if (!config.prompt || typeof config.prompt !== "string") {
			throw new Error(`Agent '${agentName}': 'prompt' is required`);
		}

		agentOrder.push(agentName);
		agents.set(agentName, {
			name: agentName,
			template: config.template.trim(),
			prompt: config.prompt.trim(),
			worktree: config.worktree ?? false,
			branch: config.branch ?? false,
			waitsFor: Array.isArray(config.waits_for) ? config.waits_for : [],
		});
	}

	return {
		name: team.name,
		path: typeof team.path === "string" ? team.path : ".",
		workspace: typeof team.workspace === "string" ? team.workspace : "./workspace",
		expertiseDir: typeof team.expertise_dir === "string" ? team.expertise_dir : undefined,
		agents,
		agentOrder,
	};
}

export function validateTeamDefinition(def: TeamDefinition): string[] {
	const errors: string[] = [];
	const agentNames = new Set(def.agents.keys());

	for (const [agentName, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (!agentNames.has(dep)) {
				errors.push(`Agent '${agentName}' waits_for unknown agent '${dep}'`);
			}
			if (dep === agentName) {
				errors.push(`Agent '${agentName}' cannot wait for itself`);
			}
		}
		if (agent.branch && !agent.worktree) {
			errors.push(`Agent '${agentName}': branch=true requires worktree=true`);
		}
	}

	return errors;
}

// ── DAG utilities (self-contained, no SwarmDefinition dependency) ─────────────

/** Build a dependency map: agent name → set of agents it depends on. */
export function buildTeamDependencyGraph(def: TeamDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();
	for (const name of def.agents.keys()) {
		deps.set(name, new Set());
	}
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (deps.has(dep)) {
				deps.get(name)!.add(dep);
			}
		}
	}
	return deps;
}

/** Returns agent names involved in a cycle, or null if acyclic (Kahn's algorithm). */
export function detectTeamCycles(deps: Map<string, Set<string>>): string[] | null {
	const inDegree = new Map<string, number>();
	const forward = new Map<string, string[]>();

	for (const [node, nodeDeps] of deps) {
		inDegree.set(node, nodeDeps.size);
		for (const dep of nodeDeps) {
			const list = forward.get(dep) ?? [];
			list.push(node);
			forward.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) queue.push(node);
	}

	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const dependent of forward.get(node) ?? []) {
			const newDegree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	if (sorted.length < deps.size) {
		return [...deps.keys()].filter(k => !sorted.includes(k));
	}
	return null;
}

/** Build execution waves. Agents within a wave can run in parallel. */
export function buildTeamExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave: string[] = [];
		for (const node of remaining) {
			const nodeDeps = deps.get(node)!;
			if ([...nodeDeps].every(dep => completed.has(dep))) {
				wave.push(node);
			}
		}
		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${[...remaining].join(", ")}] cannot make progress. Bug in cycle detection.`,
			);
		}
		wave.sort();
		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}
		waves.push(wave);
	}

	return waves;
}
