import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Container, Markdown, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { FileEntry, SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getMarkdownTheme, getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

type Mode = "picker" | "viewer";

const MAX_THINKING_CHARS = 600;
const MAX_TOOL_ARGS_CHARS = 200;
const MAX_TOOL_RESULT_CHARS = 300;

export class SessionObserverOverlayComponent extends Container {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#mode: Mode = "picker";
	#selectList: SelectList;
	#viewerContainer: Container;
	#selectedSessionId?: string;
	#observeKeys: KeyId[];

	constructor(registry: SessionObserverRegistry, onDone: () => void, observeKeys: KeyId[]) {
		super();
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;
		this.#selectList = new SelectList([], 0, getSelectListTheme());
		this.#viewerContainer = new Container();

		this.#setupPicker();
	}

	#setupPicker(): void {
		this.#mode = "picker";
		this.children = [];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Session Observer")), 1, 0));
		this.addChild(new Spacer(1));

		const items = this.#buildPickerItems();
		this.#selectList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "main") {
				this.#onDone();
				return;
			}
			this.#selectedSessionId = item.value;
			this.#setupViewer();
		};
		this.#selectList.onCancel = () => {
			this.#onDone();
		};

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	#setupViewer(): void {
		this.#mode = "viewer";
		this.children = [];
		this.#viewerContainer = new Container();
		this.#refreshViewer();

		this.addChild(new DynamicBorder());
		this.addChild(this.#viewerContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Esc: back to picker  |  Ctrl+S: back to picker"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	refreshFromRegistry(): void {
		if (this.#mode === "picker") {
			this.#refreshPickerItems();
			return;
		}
		if (this.#mode === "viewer" && this.#selectedSessionId) {
			this.#refreshViewer();
		}
	}

	#refreshPickerItems(): void {
		const previousValue = this.#selectList.getSelectedItem()?.value;
		const items = this.#buildPickerItems();
		const nextList = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		nextList.onSelect = this.#selectList.onSelect;
		nextList.onCancel = this.#selectList.onCancel;
		if (previousValue) {
			const nextIndex = items.findIndex(item => item.value === previousValue);
			if (nextIndex >= 0) {
				nextList.setSelectedIndex(nextIndex);
			}
		}

		const selectListIndex = this.children.indexOf(this.#selectList);
		if (selectListIndex >= 0) {
			this.children[selectListIndex] = nextList;
		}
		this.#selectList = nextList;
	}

	#refreshViewer(): void {
		this.#viewerContainer.clear();
		const sessions = this.#registry.getSessions();
		const session = sessions.find(candidate => candidate.id === this.#selectedSessionId);
		if (!session) {
			this.#viewerContainer.addChild(new Text(theme.fg("dim", "Session no longer available."), 1, 0));
			return;
		}

		this.#renderSessionHeader(session);
		this.#renderSessionTranscript(session);
	}

	#renderSessionHeader(session: ObservableSession): void {
		const progress = session.progress;
		const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
		const statusText = theme.fg(statusColor, session.status);
		const agentTag = session.agent ? theme.fg("dim", ` [${session.agent}]`) : "";
		this.#viewerContainer.addChild(
			new Text(`${theme.bold(theme.fg("accent", session.label))}  ${statusText}${agentTag}`, 1, 0),
		);
		if (session.description) {
			this.#viewerContainer.addChild(new Text(theme.fg("muted", session.description), 1, 0));
		}
		if (progress) {
			const stats: string[] = [];
			if (progress.toolCount > 0) {
				stats.push(`${formatNumber(progress.toolCount)} tools`);
			}
			if (progress.tokens > 0) {
				stats.push(`${formatNumber(progress.tokens)} tokens`);
			}
			if (progress.durationMs > 0) {
				stats.push(formatDuration(progress.durationMs));
			}
			if (stats.length > 0) {
				this.#viewerContainer.addChild(new Text(theme.fg("dim", stats.join(theme.sep.dot)), 1, 0));
			}
		}
		if (session.sessionFile) {
			this.#viewerContainer.addChild(
				new Text(theme.fg("dim", `Session: ${shortenPath(session.sessionFile)}`), 1, 0),
			);
		}
		this.#viewerContainer.addChild(new DynamicBorder());
	}

	#renderSessionTranscript(session: ObservableSession): void {
		if (!session.sessionFile) {
			this.#viewerContainer.addChild(new Text(theme.fg("dim", "No session file available yet."), 1, 0));
			return;
		}

		let entries: FileEntry[];
		try {
			const text = readFileSync(session.sessionFile);
			if (!text) {
				this.#viewerContainer.addChild(new Text(theme.fg("dim", "Session file is empty."), 1, 0));
				return;
			}
			entries = parseSessionEntries(text);
		} catch (error) {
			logger.debug("Session observer failed to read session file", {
				path: session.sessionFile,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#viewerContainer.addChild(new Text(theme.fg("dim", "Unable to read session file."), 1, 0));
			return;
		}

		const messageEntries = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		if (messageEntries.length === 0) {
			this.#viewerContainer.addChild(new Text(theme.fg("dim", "No messages yet."), 1, 0));
			return;
		}

		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of messageEntries) {
			if (entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		for (const entry of messageEntries) {
			const message = entry.message;
			if (message.role === "assistant") {
				this.#renderAssistantMessage(message, toolResults);
				continue;
			}
			if (message.role === "user" || message.role === "developer") {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map(block => block.text)
								.join("\n");
				if (text.trim()) {
					const label = message.role === "developer" ? "System" : "User";
					this.#viewerContainer.addChild(new Spacer(1));
					this.#viewerContainer.addChild(
						new Text(
							`${theme.fg("dim", `[${label}]`)} ${theme.fg("muted", truncateToWidth(text.trim(), 80))}`,
							1,
							0,
						),
					);
				}
			}
		}
	}

	#renderAssistantMessage(message: AssistantMessage, toolResults: Map<string, ToolResultMessage>): void {
		for (const content of message.content) {
			if (content.type === "thinking" && content.thinking.trim()) {
				const thinking = content.thinking.trim();
				this.#viewerContainer.addChild(new Spacer(1));
				const renderedThinking =
					thinking.length > MAX_THINKING_CHARS ? `${thinking.slice(0, MAX_THINKING_CHARS)}...` : thinking;
				this.#viewerContainer.addChild(
					new Markdown(renderedThinking, 1, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
				);
				continue;
			}
			if (content.type === "text" && content.text.trim()) {
				this.#viewerContainer.addChild(new Spacer(1));
				this.#viewerContainer.addChild(new Markdown(content.text.trim(), 1, 0, getMarkdownTheme()));
				continue;
			}
			if (content.type === "toolCall") {
				this.#renderToolCall(content, toolResults);
			}
		}
	}

	#renderToolCall(
		call: { id: string; name: string; arguments: Record<string, unknown>; intent?: string },
		toolResults: Map<string, ToolResultMessage>,
	): void {
		this.#viewerContainer.addChild(new Spacer(1));
		const intent = call.intent ? theme.fg("dim", ` ${truncateToWidth(call.intent, 50)}`) : "";
		this.#viewerContainer.addChild(
			new Text(`${theme.fg("accent", "▸")} ${theme.bold(theme.fg("muted", call.name))}${intent}`, 1, 0),
		);
		const argSummary = this.#formatToolArgs(call.name, call.arguments);
		if (argSummary) {
			this.#viewerContainer.addChild(new Text(`  ${theme.fg("dim", argSummary)}`, 1, 0));
		}
		const result = toolResults.get(call.id);
		if (result) {
			this.#renderToolResult(result);
		}
	}

	#formatToolArgs(toolName: string, args: Record<string, unknown>): string {
		switch (toolName) {
			case "read":
			case "write":
			case "edit":
			case "ast_grep":
			case "ast_edit":
				return args.path ? `path: ${args.path}` : "";
			case "grep":
				return [args.pattern ? `pattern: ${args.pattern}` : "", args.path ? `path: ${args.path}` : ""]
					.filter(Boolean)
					.join(", ");
			case "find":
				return args.pattern ? `pattern: ${args.pattern}` : "";
			case "bash": {
				const command = args.command;
				if (typeof command === "string") {
					return truncateToWidth(replaceTabs(command), 70);
				}
				return "";
			}
			case "lsp":
				return [args.action, args.file, args.symbol].filter(Boolean).join(" ");
			case "task": {
				const tasks = args.tasks;
				if (Array.isArray(tasks)) {
					return `${tasks.length} task(s)`;
				}
				return "";
			}
			default: {
				const parts: string[] = [];
				let total = 0;
				for (const [key, value] of Object.entries(args)) {
					if (key.startsWith("_")) {
						continue;
					}
					const renderedValue = typeof value === "string" ? value : JSON.stringify(value);
					const entry = `${key}: ${truncateToWidth(replaceTabs(renderedValue ?? ""), 40)}`;
					if (total + entry.length > MAX_TOOL_ARGS_CHARS) {
						break;
					}
					parts.push(entry);
					total += entry.length;
				}
				return parts.join(", ");
			}
		}
	}

	#renderToolResult(result: ToolResultMessage): void {
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim();

		if (result.isError) {
			const preview = truncateToWidth(replaceTabs(text || "Error"), 70);
			this.#viewerContainer.addChild(new Text(`  ${theme.fg("error", `✗ ${preview}`)}`, 1, 0));
			return;
		}
		if (!text) {
			this.#viewerContainer.addChild(new Text(`  ${theme.fg("dim", "✓ done")}`, 1, 0));
			return;
		}
		const lines = text.split("\n");
		if (lines.length === 1 && text.length < MAX_TOOL_RESULT_CHARS) {
			this.#viewerContainer.addChild(
				new Text(`  ${theme.fg("dim", `✓ ${truncateToWidth(replaceTabs(text), 70)}`)}`, 1, 0),
			);
			return;
		}
		this.#viewerContainer.addChild(new Text(`  ${theme.fg("dim", `✓ ${lines.length} lines`)}`, 1, 0));
	}

	#buildPickerItems(): SelectItem[] {
		return this.#registry.getSessions().map(session => {
			const statusIcon =
				session.status === "active"
					? "●"
					: session.status === "completed"
						? "✓"
						: session.status === "failed"
							? "✗"
							: "○";
			const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
			const prefix = theme.fg(statusColor, statusIcon);
			const agentSuffix = session.agent ? theme.fg("dim", ` [${session.agent}]`) : "";
			const label =
				session.kind === "main"
					? `${prefix} ${session.label} (return)`
					: `${prefix} ${session.label}${agentSuffix}`;

			let description = session.description;
			if (session.progress?.currentTool) {
				const intent = session.progress.lastIntent;
				description = intent
					? `${session.progress.currentTool}: ${truncateToWidth(intent, 40)}`
					: session.progress.currentTool;
			}

			return { value: session.id, label, description };
		});
	}

	handleInput(keyData: string): void {
		for (const key of this.#observeKeys) {
			if (matchesKey(keyData, key)) {
				if (this.#mode === "viewer") {
					this.#setupPicker();
					return;
				}
				this.#onDone();
				return;
			}
		}

		if (this.#mode === "picker") {
			this.#selectList.handleInput(keyData);
			return;
		}
		if (matchesKey(keyData, "escape")) {
			this.#setupPicker();
		}
	}
}

function readFileSync(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}
