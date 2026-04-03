/**
 * Session Inspector - provides structured access to session data for replay and analysis.
 *
 * @example
 * ```typescript
 * import { SessionInspector } from "./session-inspector";
 *
 * const inspector = new SessionInspector(
 *   sessionId,
 *   sessionPath,
 *   sessionManager.getTree(),
 *   sessionManager.getEntries() as SessionEntry[],
 *   sessionManager.#leafId
 * );
 *
 * const snapshot = inspector.getSnapshot();
 * console.log(snapshot.stats);
 * ```
 */

export { SessionInspector } from "./SessionInspector";
export * from "./types";
