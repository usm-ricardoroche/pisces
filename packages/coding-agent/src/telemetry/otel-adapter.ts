import type { AgentSessionEvent } from "../session/agent-session";
import type { RuntimeTelemetryAdapter, TelemetrySpan } from "./types";
import { Attr } from "./types";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

function newTraceId(): string {
	return randomHex(16);
}

function newSpanId(): string {
	return randomHex(8);
}

// ---------------------------------------------------------------------------
// OTLP/JSON types (minimal subset for export)
// ---------------------------------------------------------------------------

interface OtlpAttribute {
	key: string;
	value: {
		stringValue?: string;
		intValue?: number;
		doubleValue?: number;
		boolValue?: boolean;
		arrayValue?: { values: { stringValue: string }[] };
	};
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status: { code: 0 | 1 | 2 }; // 0=UNSET, 1=OK, 2=ERROR
	attributes: OtlpAttribute[];
}

function msToNano(ms: number): string {
	return String(ms * 1_000_000);
}

function toOtlpAttr(key: string, value: string | number | boolean | string[]): OtlpAttribute {
	if (typeof value === "string") {
		return { key, value: { stringValue: value } };
	}
	if (typeof value === "boolean") {
		return { key, value: { boolValue: value } };
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? { key, value: { intValue: value } } : { key, value: { doubleValue: value } };
	}
	// string[]
	return { key, value: { arrayValue: { values: value.map(s => ({ stringValue: s })) } } };
}

function spanToOtlp(span: TelemetrySpan): OtlpSpan {
	const endMs = span.endTimeMs ?? Date.now();
	const statusCode = span.status === "ok" ? 1 : span.status === "error" ? 2 : 0;
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
		name: span.name,
		startTimeUnixNano: msToNano(span.startTimeMs),
		endTimeUnixNano: msToNano(endMs),
		status: { code: statusCode },
		attributes: Object.entries(span.attributes).map(([k, v]) => toOtlpAttr(k, v)),
	};
}

// ---------------------------------------------------------------------------
// Span state tracking
// ---------------------------------------------------------------------------

/** Tracks open spans by a logical key so events can close the right span. */
interface ActiveSpan {
	span: TelemetrySpan;
	/** Key used by close events to locate this span. */
	key: string;
}

// ---------------------------------------------------------------------------
// OtelTelemetryAdapter
// ---------------------------------------------------------------------------

export interface OtelAdapterOptions {
	/** OTLP HTTP endpoint, e.g. "http://localhost:4318/v1/traces". */
	endpoint: string;
	/** Service name embedded in every trace. Default: "pisces". */
	serviceName?: string;
	/** Headers added to every export request, e.g. for auth tokens. */
	headers?: Record<string, string>;
	/** Export interval in ms. Default: 5000. */
	exportIntervalMs?: number;
}

/**
 * Converts AgentSessionEvent stream into OTLP spans and exports them via
 * OTLP/JSON over HTTP. No @opentelemetry SDK dependency required.
 *
 * Span hierarchy:
 *   pisces.session
 *     pisces.turn
 *       pisces.model_call  (future: emitted when usage events arrive)
 *       pisces.tool_call
 *     pisces.auto_retry
 *     pisces.auto_compaction
 *     pisces.ttsr_interrupt
 *     pisces.task_batch     (future: not yet a distinct event)
 *       pisces.subagent_run
 *         pisces.subagent_verification
 *           pisces.subagent_verification.command
 */
export class OtelTelemetryAdapter implements RuntimeTelemetryAdapter {
	readonly #endpoint: string;
	readonly #serviceName: string;
	readonly #headers: Record<string, string>;
	readonly #exportIntervalMs: number;

	#traceId: string = newTraceId();
	#sessionSpanId: string | undefined;

	/** Open spans keyed by their logical key. */
	readonly #openSpans = new Map<string, ActiveSpan>();

	/** Completed spans waiting to be exported. */
	readonly #completedSpans: TelemetrySpan[] = [];

	#exportTimer: NodeJS.Timeout | undefined;

	constructor(options: OtelAdapterOptions) {
		this.#endpoint = options.endpoint;
		this.#serviceName = options.serviceName ?? "pisces";
		this.#exportIntervalMs = options.exportIntervalMs ?? 5000;
		this.#headers = {
			"Content-Type": "application/json",
			...options.headers,
		};
		this.#exportTimer = setInterval(() => {
			void this.#flush();
		}, this.#exportIntervalMs);
	}

	// -------------------------------------------------------------------------
	// RuntimeTelemetryAdapter
	// -------------------------------------------------------------------------

	onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			// Session
			case "agent_start":
				this.#startSpan("session", "pisces.session", undefined, {});
				break;

			case "agent_end": {
				const attrs: TelemetrySpan["attributes"] = {};
				if (event.sessionId) attrs[Attr.SESSION_ID] = event.sessionId;
				if (event.sessionFile) attrs[Attr.SESSION_FILE] = event.sessionFile;
				this.#closeSpan("session", "ok", attrs);
				break;
			}

			// Turns
			case "turn_start":
				this.#startSpan(`turn:${event.turnIndex}`, "pisces.turn", "session", {
					[Attr.TURN_INDEX]: event.turnIndex,
				});
				break;

			case "turn_end":
				this.#closeSpan(`turn:${event.turnIndex}`, "ok");
				break;

			// Tool calls
			case "tool_execution_start":
				this.#startSpan(`tool:${event.toolCallId}`, "pisces.tool_call", this.#activeTurnKey(), {
					[Attr.TOOL_CALL_ID]: event.toolCallId,
					[Attr.TOOL_NAME]: event.toolName,
				});
				break;

			case "tool_execution_end": {
				const isError = event.isError ?? false;
				this.#closeSpan(`tool:${event.toolCallId}`, isError ? "error" : "ok", {
					[Attr.TOOL_IS_ERROR]: isError,
				});
				break;
			}

			// Retry
			case "auto_retry_start":
				this.#startSpan(`retry:${event.attempt}`, "pisces.auto_retry", "session", {
					[Attr.RETRY_COUNT]: event.attempt,
					[Attr.RETRY_MAX_ATTEMPTS]: event.maxAttempts,
					[Attr.RETRY_DELAY_MS]: event.delayMs,
					[Attr.RETRY_ERROR]: event.errorMessage,
				});
				break;

			case "auto_retry_end":
				this.#closeSpan(`retry:${event.attempt}`, event.success ? "ok" : "error", {
					...(event.finalError ? { [Attr.RETRY_ERROR]: event.finalError } : {}),
				});
				break;

			// Compaction
			case "auto_compaction_start":
				this.#startSpan("compaction", "pisces.auto_compaction", "session", {
					[Attr.COMPACTION_ACTION]: event.action,
					[Attr.COMPACTION_REASON]: event.reason,
				});
				break;

			case "auto_compaction_end":
				this.#closeSpan("compaction", event.aborted ? "error" : "ok");
				break;

			// TTSR
			case "ttsr_triggered":
				this.#emitInstant("pisces.ttsr_interrupt", "session", {
					[Attr.TTSR_RULES]: event.rules.map(r => String(r)).join(","),
				});
				break;

			// Subagent lifecycle
			case "subagent_start":
				this.#startSpan(`subagent:${event.id}`, "pisces.subagent_run", "session", {
					[Attr.SUBAGENT_ID]: event.id,
					[Attr.AGENT_NAME]: event.agent,
					[Attr.SUBAGENT_ISOLATED]: event.isolated,
				});
				break;

			case "subagent_end":
				this.#closeSpan(`subagent:${event.id}`, event.exitCode === 0 ? "ok" : "error", {
					[Attr.SUBAGENT_EXIT_CODE]: event.exitCode,
					...(event.verification?.status ? { [Attr.VERIFICATION_STATUS]: event.verification.status } : {}),
				});
				break;

			// Verification lifecycle
			case "subagent_verification_start":
				this.#startSpan(
					`verification:${event.id}:${event.attempt}`,
					"pisces.subagent_verification",
					`subagent:${event.id}`,
					{
						[Attr.SUBAGENT_ID]: event.id,
						[Attr.VERIFICATION_ATTEMPT]: event.attempt,
						...(event.profile ? { [Attr.VERIFICATION_PROFILE]: event.profile } : {}),
					},
				);
				break;

			case "subagent_verification_end":
				this.#closeSpan(`verification:${event.id}:${event.attempt}`, event.status === "passed" ? "ok" : "error", {
					[Attr.VERIFICATION_STATUS]: event.status,
				});
				break;

			case "subagent_verification_command_start":
				this.#startSpan(
					`vcmd:${event.id}:${event.attempt}:${event.commandName}`,
					"pisces.subagent_verification.command",
					`verification:${event.id}:${event.attempt}`,
					{
						[Attr.SUBAGENT_ID]: event.id,
						[Attr.VERIFICATION_ATTEMPT]: event.attempt,
						[Attr.VERIFICATION_COMMAND]: event.commandName,
					},
				);
				break;

			case "subagent_verification_command_end":
				this.#closeSpan(
					`vcmd:${event.id}:${event.attempt}:${event.commandName}`,
					event.exitCode === 0 ? "ok" : "error",
					{
						[Attr.VERIFICATION_COMMAND_EXIT_CODE]: event.exitCode,
						[Attr.VERIFICATION_COMMAND_DURATION_MS]: event.durationMs,
						...(event.artifactId ? { [Attr.VERIFICATION_ARTIFACT_ID]: event.artifactId } : {}),
					},
				);
				break;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#exportTimer) {
			clearInterval(this.#exportTimer);
			this.#exportTimer = undefined;
		}
		// Close any dangling open spans
		for (const { span, key } of this.#openSpans.values()) {
			this.#finishSpan(span, key, "unset", {});
		}
		await this.#flush();
	}

	// -------------------------------------------------------------------------
	// Span helpers
	// -------------------------------------------------------------------------

	#startSpan(
		key: string,
		name: string,
		parentKey: string | undefined,
		attributes: TelemetrySpan["attributes"],
	): TelemetrySpan {
		let parentSpanId: string | undefined;
		if (parentKey === "session") {
			parentSpanId = this.#sessionSpanId;
		} else if (parentKey) {
			parentSpanId = this.#openSpans.get(parentKey)?.span.spanId;
		}

		const span: TelemetrySpan = {
			spanId: newSpanId(),
			parentSpanId,
			traceId: this.#traceId,
			name,
			startTimeMs: Date.now(),
			status: "unset",
			attributes: { ...attributes, "service.name": this.#serviceName },
		};

		if (key === "session") {
			this.#sessionSpanId = span.spanId;
		}

		this.#openSpans.set(key, { span, key });
		return span;
	}

	#closeSpan(key: string, status: TelemetrySpan["status"], extraAttributes: TelemetrySpan["attributes"] = {}): void {
		const active = this.#openSpans.get(key);
		if (!active) return;
		this.#finishSpan(active.span, key, status, extraAttributes);
	}

	#finishSpan(
		span: TelemetrySpan,
		key: string,
		status: TelemetrySpan["status"],
		extraAttributes: TelemetrySpan["attributes"],
	): void {
		span.endTimeMs = Date.now();
		span.status = status;
		Object.assign(span.attributes, extraAttributes);
		this.#openSpans.delete(key);
		this.#completedSpans.push(span);
	}

	/** Emit a zero-duration span for point-in-time events (e.g. ttsr_triggered). */
	#emitInstant(name: string, parentKey: string | undefined, attributes: TelemetrySpan["attributes"]): void {
		const key = `instant:${name}:${Date.now()}`;
		const span = this.#startSpan(key, name, parentKey, attributes);
		span.endTimeMs = span.startTimeMs;
		span.status = "ok";
		this.#openSpans.delete(key);
		this.#completedSpans.push(span);
	}

	/** Returns the key of the most-recently-opened turn span, or "session". */
	#activeTurnKey(): string {
		for (const key of this.#openSpans.keys()) {
			if (key.startsWith("turn:")) return key;
		}
		return "session";
	}

	// -------------------------------------------------------------------------
	// OTLP export
	// -------------------------------------------------------------------------

	async #flush(): Promise<void> {
		if (this.#completedSpans.length === 0) return;
		const toExport = this.#completedSpans.splice(0);
		const body = JSON.stringify({
			resourceSpans: [
				{
					resource: {
						attributes: [toOtlpAttr("service.name", this.#serviceName)],
					},
					scopeSpans: [
						{
							scope: { name: "pisces", version: "1" },
							spans: toExport.map(spanToOtlp),
						},
					],
				},
			],
		});
		try {
			await fetch(this.#endpoint, {
				method: "POST",
				headers: this.#headers,
				body,
			});
		} catch {
			// Network failures are non-fatal; spans are lost on failure.
			// Do not re-queue — prevents unbounded accumulation.
		}
	}
}
