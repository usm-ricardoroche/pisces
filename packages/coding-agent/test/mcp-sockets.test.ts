import { describe, expect, it } from "bun:test";

/**
 * Parses PISCES_MCP_SOCKETS colon-separated socket paths.
 * Mirrors the logic in main.ts lines 771-790.
 */
function parseMcpSocketPaths(envValue: string): string[] {
	return envValue.split(":").filter(Boolean);
}

/**
 * Generates MCP server names from socket paths.
 * Mirrors the logic in main.ts lines 778-786.
 */
function generateMcpServerNames(sockets: string[]): Record<string, { type: "stdio"; command: string; args: string[] }> {
	const servers: Record<string, { type: "stdio"; command: string; args: string[] }> = {};
	for (const [idx, sock] of sockets.entries()) {
		const base = sock
			.replace(/\.sock$/, "")
			.replace(/.*[/\\]/, "")
			.replace(/[^a-z0-9_]/gi, "_")
			.slice(0, 40);
		const name = idx === 0 ? `shoal_${base}` : `shoal_${base}_${idx}`;
		servers[name] = { type: "stdio", command: "nc", args: ["-U", sock] };
	}
	return servers;
}

describe("MCP Socket Parsing", () => {
	describe("parseMcpSocketPaths", () => {
		it("parses single socket path", () => {
			const result = parseMcpSocketPaths("/tmp/mcp.sock");
			expect(result).toEqual(["/tmp/mcp.sock"]);
		});

		it("parses multiple socket paths", () => {
			const result = parseMcpSocketPaths("/tmp/mcp.sock:/tmp/mcp2.sock:/tmp/mcp3.sock");
			expect(result).toEqual(["/tmp/mcp.sock", "/tmp/mcp2.sock", "/tmp/mcp3.sock"]);
		});

		it("filters empty strings", () => {
			const result = parseMcpSocketPaths("/tmp/a.sock::b.sock");
			expect(result).toEqual(["/tmp/a.sock", "b.sock"]);
		});

		it("returns empty array for empty string", () => {
			const result = parseMcpSocketPaths("");
			expect(result).toEqual([]);
		});

		it("returns empty array for single colon", () => {
			const result = parseMcpSocketPaths(":");
			expect(result).toEqual([]);
		});

		it("handles leading and trailing colons", () => {
			const result = parseMcpSocketPaths(":/tmp/mcp.sock:");
			expect(result).toEqual(["/tmp/mcp.sock"]);
		});

		it("handles socket paths with dots in directory names", () => {
			const result = parseMcpSocketPaths("/tmp/dev.test/mcp.sock");
			expect(result).toEqual(["/tmp/dev.test/mcp.sock"]);
		});
	});

	describe("generateMcpServerNames", () => {
		it("generates shoal_ prefix for single socket", () => {
			const servers = generateMcpServerNames(["/tmp/mcp.sock"]);
			expect(Object.keys(servers)).toEqual(["shoal_mcp"]);
		});

		it("generates unique names for multiple sockets", () => {
			const servers = generateMcpServerNames(["/tmp/mcp1.sock", "/tmp/mcp2.sock"]);
			// idx=0: shoal_mcp1, idx=1: shoal_mcp2_1
			expect(Object.keys(servers)).toEqual(["shoal_mcp1", "shoal_mcp2_1"]);
		});

		it("uses nc -U for stdio transport", () => {
			const servers = generateMcpServerNames(["/tmp/mcp.sock"]);
			expect(servers.shoal_mcp).toEqual({
				type: "stdio",
				command: "nc",
				args: ["-U", "/tmp/mcp.sock"],
			});
		});

		it("removes .sock extension from name", () => {
			const servers = generateMcpServerNames(["/tmp/my-server.sock"]);
			expect(Object.keys(servers)).toEqual(["shoal_my_server"]);
		});

		it("truncates names to 40 chars", () => {
			const longPath = `/tmp/${"a".repeat(50)}.sock`;
			const servers = generateMcpServerNames([longPath]);
			const name = Object.keys(servers)[0];
			// "shoal_" (6) + base (40 max) = 46 chars max
			expect(name.length).toBeLessThanOrEqual(46);
		});

		it("replaces non-alphanumeric chars with underscores", () => {
			const servers = generateMcpServerNames(["/tmp/my-mcp-server.123.sock"]);
			expect(Object.keys(servers)).toEqual(["shoal_my_mcp_server_123"]);
		});

		it("handles sockets with subdirectories", () => {
			const servers = generateMcpServerNames(["/var/run/shoal/mcp.sock"]);
			expect(Object.keys(servers)).toEqual(["shoal_mcp"]);
		});

		it("handles backslash paths (Windows compatibility)", () => {
			const servers = generateMcpServerNames(["C:\\temp\\mcp.sock"]);
			expect(Object.keys(servers)).toEqual(["shoal_mcp"]);
		});
	});

	describe("end-to-end: env var to server config", () => {
		it("full pipeline: multiple sockets from env", () => {
			const envValue = "/tmp/filesystem.sock:/tmp/search.sock";
			const sockets = parseMcpSocketPaths(envValue);
			const servers = generateMcpServerNames(sockets);

			expect(Object.keys(servers)).toHaveLength(2);
			expect(servers.shoal_filesystem).toBeDefined();
			expect(servers.shoal_filesystem.args).toEqual(["-U", "/tmp/filesystem.sock"]);
			// idx=1 gets _1 suffix
			expect(servers.shoal_search_1).toBeDefined();
			expect(servers.shoal_search_1.args).toEqual(["-U", "/tmp/search.sock"]);
		});

		it("env var takes precedence over empty config", () => {
			// This tests the logic: envSockets.length > 0 ? envSockets : configSockets
			const envSockets = parseMcpSocketPaths("/tmp/env.sock");
			const configSockets: string[] = [];
			const effectiveSockets = envSockets.length > 0 ? envSockets : configSockets;

			expect(effectiveSockets).toEqual(["/tmp/env.sock"]);
		});

		it("config fallback when env is empty", () => {
			const envSockets = parseMcpSocketPaths("");
			const configSockets = ["/tmp/config1.sock", "/tmp/config2.sock"];
			const effectiveSockets = envSockets.length > 0 ? envSockets : configSockets;

			expect(effectiveSockets).toEqual(["/tmp/config1.sock", "/tmp/config2.sock"]);
		});
	});
});
