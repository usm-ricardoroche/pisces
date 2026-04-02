import type { SettingPath } from "./settings-schema";

export type PresetName = "default" | "lobster" | "headless" | "minimal";

export const PRESETS: Record<Exclude<PresetName, "default">, Partial<Record<SettingPath, unknown>>> = {
	lobster: {
		"pisces.lobsterMode": true,
		"pisces.noProviderDiscovery": true,
		"autoresearch.enabled": false,
		"ssh.enabled": false,
		"shoal.enabled": false,
		"stt.enabled": false,
		"memories.enabled": false,
		"startup.quiet": true,
	},
	headless: {
		"autoresearch.enabled": false,
		"ssh.enabled": false,
		"stt.enabled": false,
		"startup.quiet": true,
		"shoal.enabled": false,
	},
	minimal: {
		"find.enabled": false,
		"grep.enabled": false,
		"astGrep.enabled": false,
		"astEdit.enabled": false,
		"autoresearch.enabled": false,
		"todo.enabled": false,
		"web_search.enabled": false,
		"browser.enabled": false,
		"notebook.enabled": false,
		"ssh.enabled": false,
		"shoal.enabled": false,
	},
};
