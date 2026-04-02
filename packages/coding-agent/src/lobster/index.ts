/**
 * Lobster extension entry point.
 *
 * Exports the lobster tool set for registration via CreateAgentSessionOptions.customTools.
 * Loaded in main.ts when PISCES_LOBSTER_MODE=1 is set.
 */
export { memorySearchTool, messageUserTool } from "./tools";
