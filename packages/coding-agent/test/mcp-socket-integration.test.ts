import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { StdioTransport } from "../src/mcp/transports/stdio";
import type { MCPStdioServerConfig } from "../src/mcp/types";

/**
 * Integration test for Unix socket MCP connections.
 *
 * Tests the full path: nc -U <socket> -> Unix socket MCP server.
 * This validates PISCES_MCP_SOCKETS feature end-to-end.
 */

describe("MCP Unix Socket Integration", () => {
	let socketPath: string;
	let mcpServer: net.Server;

	beforeEach(async () => {
		// Create a temporary socket path
		socketPath = path.join(Bun.env.TMPDIR ?? "/tmp", `mcp-test-${Date.now()}.sock`);

		// Create a minimal MCP server that speaks JSON-RPC
		mcpServer = net.createServer(conn => {
			let buffer = "";

			conn.on("data", data => {
				buffer += data.toString();

				// Process complete JSON lines
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;

					try {
						const msg = JSON.parse(line);

						// Handle initialize request
						if (msg.method === "initialize") {
							const response = {
								jsonrpc: "2.0",
								id: msg.id,
								result: {
									protocolVersion: "2024-11-05",
									capabilities: { tools: {} },
									serverInfo: { name: "test-socket-server", version: "1.0.0" },
								},
							};
							conn.write(`${JSON.stringify(response)}\n`);
						}

						// Handle tool list request
						if (msg.method === "tools/list") {
							const response = {
								jsonrpc: "2.0",
								id: msg.id,
								result: {
									tools: [
										{
											name: "test_tool",
											description: "A test tool via Unix socket",
											inputSchema: { type: "object", properties: { query: { type: "string" } } },
										},
									],
								},
							};
							conn.write(`${JSON.stringify(response)}\n`);
						}

						// Handle tool call
						if (msg.method === "tools/call") {
							const response = {
								jsonrpc: "2.0",
								id: msg.id,
								result: {
									content: [{ type: "text", text: `Echo: ${JSON.stringify(msg.params?.arguments)}` }],
								},
							};
							conn.write(`${JSON.stringify(response)}\n`);
						}

						// Handle notifications (no response needed)
						if (msg.id === undefined) {
							// Send back an initialized notification
							if (msg.method === "notifications/initialized") {
								// No response needed for notifications
							}
						}
					} catch {
						// Skip malformed JSON
					}
				}
			});

			conn.on("end", () => {
				conn.destroy();
			});
		});

		await new Promise<void>(resolve => {
			mcpServer.listen(socketPath, resolve);
		});
	});

	afterEach(async () => {
		mcpServer.close();
		// Clean up socket file
		try {
			fs.unlinkSync(socketPath);
		} catch {
			// Socket may already be cleaned up
		}
	});

	it("connects to Unix socket MCP server via nc -U", async () => {
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: "nc",
			args: ["-U", socketPath],
		};

		const transport = new StdioTransport(config);
		await transport.connect();

		expect(transport.connected).toBe(true);

		await transport.close();
	});

	it("receives server info from Unix socket MCP server", async () => {
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: "nc",
			args: ["-U", socketPath],
		};

		const transport = new StdioTransport(config);
		await transport.connect();

		// Send initialize request
		const response = await transport.request("initialize", {
			protocolVersion: "2024-11-05",
			clientInfo: { name: "test-client", version: "1.0.0" },
			capabilities: {},
		});

		expect(response).toBeDefined();
		expect((response as { serverInfo?: { name?: string } }).serverInfo?.name).toBe("test-socket-server");

		await transport.close();
	});

	it("lists tools from Unix socket MCP server", async () => {
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: "nc",
			args: ["-U", socketPath],
		};

		const transport = new StdioTransport(config);
		await transport.connect();

		// Initialize first
		await transport.request("initialize", {
			protocolVersion: "2024-11-05",
			clientInfo: { name: "test-client", version: "1.0.0" },
			capabilities: {},
		});

		// List tools
		const response = await transport.request("tools/list", {});

		expect(response).toBeDefined();
		const tools = (response as { tools?: unknown[] }).tools ?? [];
		expect(tools.length).toBeGreaterThan(0);
		expect((tools[0] as { name?: string }).name).toBe("test_tool");

		await transport.close();
	});
});
