// The tools a managed pi session inherits from the user's own pi configuration
// (global-tool-parity-for-managed-agents).
//
// Scope: the *user-level* settings file only. pi merges a project-level
// `<cwd>/.pi/settings.json` on top, but a managed session launches with
// `--no-approve`, so pi itself ignores project-local files for that run;
// reading one here would hand an agent a tool the session it belongs to would
// not otherwise load.
//
// Two pi mechanisms hide a configured tool from a managed agent, and this module
// exists to name both:
//
// - `--tools` is a strict allowlist over built-in, extension and custom tools, so
//   it *replaces* the selection `defaultTools` would have produced. A profile that
//   declares tools therefore hides `codemode`, even when the user enabled it
//   globally.
// - `--no-extensions` disables built-in extensions too, and managed sessions pass
//   it to keep the user's extension files out of a run. `codemode` lives in the
//   `builtin:codemode` extension, so it disappears entirely.
//
// So a globally enabled tool needs two things from the launch: its name in the
// allowlist, and its built-in extension requested explicitly (pi documents that
// explicit `-e` paths still load under `--no-extensions`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** pi's built-in tools. A name in this set is selected by the profile, never by
 * the user's global tool configuration: the workflow's read-only policy and its
 * handoff path depend on it. */
const PI_BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/** Built-in extensions that register a tool a user can enable globally. The value
 * is pi's `builtin:` extension name. Only tools from this map can be handed to a
 * managed session: a tool from a user's own extension file cannot, because
 * managed sessions deliberately do not load user extensions. */
const BUILTIN_EXTENSION_BY_TOOL: Readonly<Record<string, string>> = {
	codemode: "codemode",
	tool_search: "tool-search",
};

/** A globally enabled tool and the built-in extension that provides it. */
export interface GlobalPiTool {
	readonly tool: string;
	readonly extension: string;
}

/** pi's user settings file. Mirrors pi's own resolution: its agent directory,
 * overridable through `PI_CODING_AGENT_DIR`, defaults to `~/.pi/agent`. An
 * empty or blank override counts as unset, as it does in pi's own config-root
 * resolution. */
export function piSettingsPath(
	agentDir: string | undefined = process.env.PI_CODING_AGENT_DIR,
): string {
	const configured = agentDir?.trim();
	const root = configured
		? configured
		: path.join(os.homedir(), ".pi", "agent");
	return path.join(root, "settings.json");
}

/** pi's `defaultTools` resolution, narrowed to the tools a managed session can
 * actually be given. Plain names form the selection, `+name`/`-name` then apply
 * in order — pi's own rule, kept so a removal is honored the same way pi honors
 * it. */
function selectedToolNames(entries: readonly unknown[]): Set<string> {
	const selected = new Set<string>();
	for (const entry of entries)
		if (typeof entry === "string" && entry.trim().length > 0) {
			const name = entry.trim();
			if (name.startsWith("+")) selected.add(name.slice(1));
			else if (name.startsWith("-")) selected.delete(name.slice(1));
			else {
				selected.clear();
				selected.add(name);
			}
		}
	return selected;
}

/** The globally configured tools a managed pi agent should receive. An absent,
 * unreadable or malformed settings file contributes nothing: an optional tool
 * must never fail a launch. */
export function globalPiTools(
	settingsPath: string = piSettingsPath(),
): readonly GlobalPiTool[] {
	let settings: { defaultTools?: unknown };
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			defaultTools?: unknown;
		};
	} catch {
		return [];
	}
	const entries = settings?.defaultTools;
	if (!Array.isArray(entries)) return [];
	const found: GlobalPiTool[] = [];
	for (const name of selectedToolNames(entries)) {
		if (PI_BUILTIN_TOOLS.has(name)) continue;
		const extension = BUILTIN_EXTENSION_BY_TOOL[name];
		if (extension) found.push({ tool: name, extension });
	}
	return found;
}
