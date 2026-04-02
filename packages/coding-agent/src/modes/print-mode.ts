/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages } = options;

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			process.stdout.write(`${JSON.stringify(header)}\n`);
		}
	}
	// Set up extensions for print mode (no UI, no command context)
	const extensionRunner = session.extensionRunner;
	if (extensionRunner) {
		extensionRunner.initialize(
			// ExtensionActions
			{
				sendMessage: (message, options) => {
					session.sendCustomMessage(message, options).catch(e => {
						process.stderr.write(`Extension sendMessage failed: ${e instanceof Error ? e.message : String(e)}\n`);
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch(e => {
						process.stderr.write(
							`Extension sendUserMessage failed: ${e instanceof Error ? e.message : String(e)}\n`,
						);
					});
				},
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => session.getAllToolNames(),
				setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
				getCommands: () => [],
				setModel: async model => {
					const key = await session.modelRegistry.getApiKey(model);
					if (!key) return false;
					await session.setModel(model);
					return true;
				},
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
			},
			// ExtensionContextActions
			{
				getModel: () => session.model,
				getSearchDb: () => session.searchDb,
				isIdle: () => !session.isStreaming,
				abort: () => session.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => session.getContextUsage(),
				getSystemPrompt: () => session.systemPrompt,
				compact: async instructionsOrOptions => {
					const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
					const options =
						instructionsOrOptions && typeof instructionsOrOptions === "object"
							? instructionsOrOptions
							: undefined;
					await session.compact(instructions, options);
				},
			},
			// ExtensionCommandContextActions - commands invokable via prompt("/command")
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async options => {
					const success = await session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await session.reload();
				},
				compact: async instructionsOrOptions => {
					const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
					const options =
						instructionsOrOptions && typeof instructionsOrOptions === "object"
							? instructionsOrOptions
							: undefined;
					await session.compact(instructions, options);
				},
			},
			// No UI context
		);
		extensionRunner.onError(err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		});
		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	});

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		await session.prompt(initialMessage, { images: initialImages });
	}

	// Send remaining messages
	for (const message of messages) {
		await session.prompt(message);
	}

	// Check last assistant message for error — applies in both text and json modes.
	{
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				const message = assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`;
				if (mode === "json") {
					process.stdout.write(`${JSON.stringify({ type: "error", code: "TURN_FAILED", message })}\n`);
				} else {
					process.stderr.write(`${message}\n`);
				}
				process.exit(1);
			}
		}
	}

	// In text mode, output final response text
	if (mode === "text") {
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		if (lastMessage?.role === "assistant") {
			const assistantMsg = lastMessage as AssistantMessage;
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					process.stdout.write(`${content.text}\n`);
				}
			}
		}
	}

	// Drain the session persist queue before dispose. Even though dispose()
	// calls sessionManager.close(), an explicit flush here ensures the
	// append-writer is fsynced regardless of #persistWriter state at call time.
	await session.sessionManager.flush();

	// Flush stdout before exiting so no output is lost on fast Bun exits.
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", err => {
			if (err) reject(err);
			else resolve();
		});
	});

	await session.dispose();
}
