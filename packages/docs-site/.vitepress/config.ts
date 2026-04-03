import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	title: "oh my pi",
	description: "AI coding agent for the terminal",
	srcDir: "../../docs",
	outDir: "../../dist/docs-site",
	base: "/oh-my-pi/",
	ignoreDeadLinks: [/\.\.\/packages\//],


	vite: {
		publicDir: path.resolve(__dirname, "../../../assets"),
		resolve: {
			alias: {
				vue: path.resolve(__dirname, "../node_modules/vue"),
				"vue/server-renderer": path.resolve(__dirname, "../node_modules/vue/server-renderer"),
			},
		},
	},

	head: [
		["link", { rel: "icon", href: "/oh-my-pi/icon.svg", type: "image/svg+xml" }],
	],

	themeConfig: {
		logo: "/icon.svg",
		siteTitle: "oh my pi",

		nav: [
			{ text: "Guide", link: "/session" },
			{ text: "Configuration", link: "/config-usage" },
			{ text: "SDK", link: "/sdk" },
			{
				text: "GitHub",
				link: "https://github.com/can1357/oh-my-pi",
			},
		],

		sidebar: [
			{
				text: "Getting Started",
				items: [
					{ text: "Sessions", link: "/session" },
					{ text: "Configuration", link: "/config-usage" },
					{ text: "Environment Variables", link: "/environment-variables" },
					{ text: "Models", link: "/models" },
					{ text: "Secrets", link: "/secrets" },
					{ text: "Memory", link: "/memory" },
					{ text: "Theme", link: "/theme" },
				],
			},
			{
				text: "Core Features",
				items: [
					{ text: "Extensions", link: "/extensions" },
					{ text: "Extension Loading", link: "/extension-loading" },
					{ text: "Skills", link: "/skills" },
					{ text: "Hooks", link: "/hooks" },
					{ text: "Custom Tools", link: "/custom-tools" },
					{ text: "Marketplace", link: "/marketplace" },
					{ text: "Compaction", link: "/compaction" },
					{ text: "TTSR Injection Lifecycle", link: "/ttsr-injection-lifecycle" },
				],
			},
			{
				text: "Tools",
				items: [
					{ text: "Bash Tool Runtime", link: "/bash-tool-runtime" },
					{ text: "Notebook Tool Runtime", link: "/notebook-tool-runtime" },
					{ text: "Python REPL", link: "/python-repl" },
					{ text: "Resolve Tool Runtime", link: "/resolve-tool-runtime" },
					{ text: "Task Agent Discovery", link: "/task-agent-discovery" },
					{ text: "Tree", link: "/tree" },
				],
			},
			{
				text: "Sessions",
				items: [
					{ text: "Session Operations", link: "/session-operations-export-share-fork-resume" },
					{ text: "Session Switching & Recents", link: "/session-switching-and-recent-listing" },
					{ text: "Session Tree Plan", link: "/session-tree-plan" },
				],
			},
			{
				text: "TUI",
				items: [
					{ text: "TUI Overview", link: "/tui" },
					{ text: "TUI Runtime Internals", link: "/tui-runtime-internals" },
				],
			},
			{
				text: "MCP & Plugins",
				items: [
					{ text: "MCP Config", link: "/mcp-config" },
					{ text: "MCP Protocol Transports", link: "/mcp-protocol-transports" },
					{ text: "MCP Runtime Lifecycle", link: "/mcp-runtime-lifecycle" },
					{ text: "MCP Server Tool Authoring", link: "/mcp-server-tool-authoring" },
					{ text: "Plugin Manager & Installer", link: "/plugin-manager-installer-plumbing" },
				],
			},
			{
				text: "Slash Commands",
				items: [
					{ text: "Slash Command Internals", link: "/slash-command-internals" },
					{ text: "Rulebook Matching Pipeline", link: "/rulebook-matching-pipeline" },
				],
			},
			{
				text: "SDK & RPC",
				items: [
					{ text: "SDK", link: "/sdk" },
					{ text: "RPC", link: "/rpc" },
					{ text: "Provider Streaming Internals", link: "/provider-streaming-internals" },
					{ text: "Gemini Manifest Extensions", link: "/gemini-manifest-extensions" },
					{ text: "Handoff Generation Pipeline", link: "/handoff-generation-pipeline" },
				],
			},
			{
				text: "Natives",
				items: [
					{ text: "Architecture", link: "/natives-architecture" },
					{ text: "Addon Loader Runtime", link: "/natives-addon-loader-runtime" },
					{ text: "Binding Contract", link: "/natives-binding-contract" },
					{ text: "Build, Release & Debugging", link: "/natives-build-release-debugging" },
					{ text: "Media & System Utils", link: "/natives-media-system-utils" },
					{ text: "Rust Task Cancellation", link: "/natives-rust-task-cancellation" },
					{ text: "Shell / PTY / Process", link: "/natives-shell-pty-process" },
					{ text: "Text Search Pipeline", link: "/natives-text-search-pipeline" },
				],
			},
			{
				text: "Architecture",
				items: [
					{ text: "Blob Artifact Architecture", link: "/blob-artifact-architecture" },
					{ text: "FS Scan Cache Architecture", link: "/fs-scan-cache-architecture" },
					{ text: "Non-Compaction Retry Policy", link: "/non-compaction-retry-policy" },
				],
			},
			{
				text: "Migration",
				items: [
					{ text: "Porting from pi-mono", link: "/porting-from-pi-mono" },
					{ text: "Porting to Natives", link: "/porting-to-natives" },
				],
			},
		],

		search: {
			provider: "local",
		},

		socialLinks: [
			{ icon: "github", link: "https://github.com/usm-ricardoroche/pisces" },
		],

		editLink: {
			pattern: "https://github.com/usm-ricardoroche/pisces/edit/main/docs/:path",
			text: "Edit this page on GitHub",
		},

		footer: {
			message: "MIT License",
			copyright: "Copyright © can1357",
		},
	},
});
