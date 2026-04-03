import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { reset as resetDiscovery, setDisabledProviders } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";

describe("Claude MCP discovery", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-mcp-"));
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setDisabledProviders([]);
		resetDiscovery();
		clearFsCache();
		await fs.mkdir(path.join(tempHomeDir, ".claude"), { recursive: true });
	});

	afterEach(async () => {
		setDisabledProviders([]);
		resetDiscovery();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempHomeDir, { recursive: true, force: true });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("skips Claude MCP servers marked enabled false", async () => {
		await fs.writeFile(
			path.join(tempHomeDir, ".claude", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					linear: {
						enabled: false,
						type: "http",
						url: "https://mcp.linear.app/mcp",
					},
					docs: {
						type: "http",
						url: "https://docs.example.com/mcp",
					},
				},
			}),
		);

		const result = await loadAllMCPConfigs(tempDir, { filterExa: false });

		expect(result.configs.linear).toBeUndefined();
		expect(result.configs.docs).toMatchObject({
			type: "http",
			url: "https://docs.example.com/mcp",
		});
	});

	test("respects enabled false from ~/.claude/.mcp.json (dotfile variant)", async () => {
		await fs.writeFile(
			path.join(tempHomeDir, ".claude", ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					linear: {
						enabled: false,
						type: "http",
						url: "https://mcp.linear.app/mcp",
					},
					docs: {
						type: "http",
						url: "https://docs.example.com/mcp",
					},
				},
			}),
		);

		const result = await loadAllMCPConfigs(tempDir, { filterExa: false });

		expect(result.configs.linear).toBeUndefined();
		expect(result.configs.docs).toMatchObject({
			type: "http",
			url: "https://docs.example.com/mcp",
		});
	});
});
