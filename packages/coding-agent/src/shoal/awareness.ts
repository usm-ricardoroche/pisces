/**
 * awareness.ts — best-effort Shoal session context for the system prompt.
 *
 * Uses list_sessions via ShoalMcpBridge with server-side path filtering.
 * See PISCES_SHOAL_EXECUTION_MODEL.md.
 *
 * Contract:
 *   - read-only; never writes
 *   - every code path degrades silently — if the MCP server is absent or
 *     returns an error, awareness simply returns nothing
 *   - MUST NOT be used for orchestration correctness, task completion,
 *     worker targeting, or approval logic
 *   - suitable only for non-critical context injection (session names, status,
 *     tool, worktree overlap)
 */

import type { ExtensionFactory } from "../extensibility/extensions/types";
import { ShoalMcpBridge } from "./session-lifecycle";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShoalSession {
	name: string;
	status: string;
	tool: string;
	worktree: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchRepoSessions(cwd: string): Promise<ShoalSession[]> {
	const bridge = new ShoalMcpBridge();
	try {
		await bridge.connect();
		const sessions = await bridge.listSessions(cwd);
		return sessions.map(s => ({ name: s.name, status: s.status, tool: s.tool, worktree: s.worktree || s.path }));
	} catch {
		return [];
	} finally {
		await bridge.disconnect().catch(() => {});
	}
}

function formatInline(sessions: ShoalSession[]): string {
	return sessions.map(s => `${s.name} [${s.tool}/${s.status}]`).join(", ");
}

// ── Extension factory ─────────────────────────────────────────────────────────

/**
 * Inline extension registered in main.ts.
 *
 * Hooks:
 *   before_agent_start — inject active shoal session summary into system prompt.
 *   session.compacting  — preserve session awareness across compaction.
 */
export const shoalExtension: ExtensionFactory = pi => {
	pi.setLabel("shoal");

	pi.on("before_agent_start", async event => {
		const sessions = await fetchRepoSessions(process.cwd());
		if (!sessions.length) return {};

		const summary = formatInline(sessions);
		const injection = [
			"\n\n---",
			`Active shoal sessions for this repo: ${summary}`,
			"Use shoal MCP tools to coordinate: session_snapshot, wait_for_completion,",
			"send_session_message, receive_session_messages. Prefer /team for new work.",
			"---",
		].join("\n");

		return { systemPrompt: event.systemPrompt + injection };
	});

	pi.on("session.compacting", async () => {
		const sessions = await fetchRepoSessions(process.cwd());
		if (!sessions.length) return {};

		return {
			context: [`Shoal sessions active for this repo: ${formatInline(sessions)}`],
		};
	});
};
