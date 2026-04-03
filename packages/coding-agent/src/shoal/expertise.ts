/**
 * Expertise fin integration.
 *
 * After a Shoal session completes, this module triggers the `pisces-expertise`
 * fin to extract what the agent learned and append it to the template's
 * expertise file. The fin lives in shoal-cli and is invoked via the CLI.
 *
 * The fin contract:
 *   shoal fin run ~/.config/shoal/fins/pisces-expertise -- <session> --template <template>
 *
 * What the fin does (implemented in shoal-cli):
 *   1. Reads journal + capture_pane output for the session
 *   2. LLM-summarizes key discoveries (codepaths, patterns, gotchas)
 *   3. Appends to ~/.config/shoal/templates/<template>/expertise.md
 *   4. Template auto-picks up the file on next session creation
 *
 * If `shoal-mcp-server` is not installed or the fin doesn't exist, this is a
 * silent no-op — expertise updates are best-effort, never blocking.
 */

import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export const PISCES_EXPERTISE_FIN = "pisces-expertise";

/**
 * Trigger the expertise fin for a completed session.
 *
 * Runs `shoal fin run pisces-expertise <session> --template <template>` as a
 * fire-and-forget subprocess. Errors are logged as warnings, never thrown.
 */
export async function triggerExpertiseFin(session: string, template: string): Promise<void> {
	const finPath = `${shoalConfigDir()}/fins/${PISCES_EXPERTISE_FIN}`;
	const result = await $`shoal fin run ${finPath} -- ${session} --template ${template}`.quiet().nothrow();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		logger.warn("Expertise fin returned non-zero exit", {
			session,
			template,
			exitCode: result.exitCode,
			stderr: stderr.slice(0, 200),
		});
	} else {
		logger.debug("Expertise fin completed", { session, template });
	}
}

/**
 * Read the current expertise file content for a template.
 * Returns null if the file doesn't exist.
 */
export async function readExpertise(template: string): Promise<string | null> {
	const expertisePath = getExpertisePath(template);
	try {
		return await Bun.file(expertisePath).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/**
 * Append a new expertise note directly (bypasses the fin, for manual use).
 */
export async function appendExpertise(template: string, note: string): Promise<void> {
	const expertisePath = getExpertisePath(template);
	const existing = await readExpertise(template);
	const separator = existing ? "\n\n---\n\n" : "";
	const timestamp = new Date().toISOString().slice(0, 10);
	await Bun.write(expertisePath, `${existing ?? ""}${separator}## ${timestamp}\n\n${note}\n`);
}

function shoalConfigDir(): string {
	const base = Bun.env.XDG_CONFIG_HOME ?? `${Bun.env.HOME ?? process.env.HOME ?? "~"}/.config`;
	return `${base}/shoal`;
}

function getExpertisePath(template: string): string {
	return `${shoalConfigDir()}/templates/${template}/expertise.md`;
}
