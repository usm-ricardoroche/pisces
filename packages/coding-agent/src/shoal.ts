/**
 * shoal.ts — Shoal-first integration for pisces.
 *
 * Reads the Shoal SQLite DB directly (no daemon round-trip) to discover sessions
 * whose worktrees overlap with the current repo, then injects a compact summary
 * into the system prompt via a `before_agent_start` inline extension.
 *
 * Zero noise when Shoal is idle or not installed — every codepath degrades silently.
 */

import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionFactory } from "./extensibility/extensions/types";

// ── Session model ─────────────────────────────────────────────────────────────

interface ShoalSession {
	name: string;
	status: string;
	tool: string;
	worktree: string;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function shoalDbPath(): string {
	const xdgData = Bun.env.XDG_DATA_HOME;
	const base = xdgData ?? path.join(os.homedir(), ".local", "share");
	return path.join(base, "shoal", "shoal.db");
}

function readSessions(): ShoalSession[] | null {
	try {
		const db = new Database(shoalDbPath(), { readonly: true, create: false });
		const rows = db.query("SELECT data FROM sessions").all() as Array<{ data: string }>;
		db.close();
		return rows.map(r => {
			const d = JSON.parse(r.data) as Record<string, unknown>;
			return {
				name: d.name as string,
				status: (d.status as string | undefined) ?? "unknown",
				tool: (d.tool as string | undefined) ?? "",
				worktree: ((d.worktree as string) || (d.path as string)) ?? "",
			};
		});
	} catch {
		return null;
	}
}

function filterByRepo(sessions: ShoalSession[], cwd: string): ShoalSession[] {
	const base = cwd.replace(/\/+$/, "");
	return sessions.filter(s => s.worktree === base || s.worktree.startsWith(`${base}/`));
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

	pi.on("before_agent_start", event => {
		const sessions = readSessions();
		if (!sessions?.length) return {};

		const repoSessions = filterByRepo(sessions, process.cwd());
		if (!repoSessions.length) return {};

		const summary = formatInline(repoSessions);
		const injection = [
			"\n\n---",
			`Active shoal sessions for this repo: ${summary}`,
			"Use shoal MCP tools (list_sessions, session_status, send_keys, capture_pane)",
			"or batch_execute / wait_for_completion to delegate and coordinate work.",
			"---",
		].join("\n");

		return { systemPrompt: event.systemPrompt + injection };
	});

	pi.on("session.compacting", () => {
		const sessions = readSessions();
		if (!sessions?.length) return {};

		const repoSessions = filterByRepo(sessions, process.cwd());
		if (!repoSessions.length) return {};

		return {
			context: [`Shoal sessions active for this repo: ${formatInline(repoSessions)}`],
		};
	});
};
