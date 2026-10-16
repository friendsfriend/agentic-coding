// One local UI preferences adapter for every feature surface. The canonical
// file is `<config root>/tui.json`, where the root comes from the shared
// resolver: `AGENTIC_CODING_CONFIG_DIR`, then `~/.config/agentic-coding`.
// A canonical `theme` value always wins, even when it is not currently
// registered. Unrelated canonical keys are always preserved and writes are
// atomic so a failed save never corrupts the last good file. Workflow execution
// settings stay in their own provenance-aware config and are not touched here.
import fs from "node:fs";
import path from "node:path";
import {
	isThemeJson,
	setActiveThemeName,
	setCustomThemes,
	type ThemeJson,
	themeNames,
} from "@ui";
import { resolveConfigRoot } from "../../config-root.ts";

/** Directory that owns `tui.json` and the custom `themes/` folder. */
export function configDir(): string {
	return resolveConfigRoot();
}

/** Canonical local UI preferences file. */
export function themeSettingsPath(): string {
	return path.join(configDir(), "tui.json");
}

/** Built-in names captured before any custom theme is registered. */
const BUILTIN_THEME_NAMES = new Set(themeNames);

function readJsonSettings(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(themeSettingsPath(), "utf8"),
		) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Read the canonical `theme` value from `tui.json`, or undefined when the
 * file, or the key, is absent. */
function readCanonicalThemeName(): unknown {
	return readJsonSettings().theme;
}

/**
 * Write preferences atomically (temp file + rename) so a crash or write
 * failure leaves the previous file intact. Throws when the directory or file
 * is not writable.
 */
export function writeSettingsAtomically(
	settings: Record<string, unknown>,
): void {
	const target = themeSettingsPath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	try {
		// Prompt history can contain private input; keep client state owner-only.
		fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.renameSync(temp, target);
	} catch (error) {
		try {
			fs.rmSync(temp, { force: true });
		} catch {
			// Best-effort cleanup; the original error is what matters.
		}
		throw error;
	}
}

/** A valid selection is a known (built-in, custom or captured) theme name. */
export function isValidThemeName(name: unknown): name is string {
	return typeof name === "string" && themeNames.includes(name);
}

/**
 * Resolve the active theme without modifying the settings file. A canonical
 * selection always wins, even when it is not currently registered (e.g. a
 * persisted `system` before capture, or a removed custom theme) so startup
 * never overwrites it. Otherwise the default `catppuccin` is returned.
 */
export function loadThemeName(): string {
	const canonical = readCanonicalThemeName();
	if (canonical === undefined) return "catppuccin";
	return isValidThemeName(canonical) ? canonical : "catppuccin";
}

/** Apply an already-validated theme name to the shared store. */
export function applyTheme(name: string): boolean {
	return setActiveThemeName(name);
}

/**
 * Persist the active theme name, preserving unrelated keys. Invalid names are
 * rejected before any write so the previous file stays intact.
 */
export function saveThemeName(name: string): void {
	if (!isValidThemeName(name)) throw new Error(`unknown theme: ${name}`);
	writeSettingsAtomically({ ...readJsonSettings(), theme: name });
}

/** Match opencode's bounded, client-local input history. */
export const MAX_PROMPT_HISTORY = 50;

export function loadPromptHistory(): string[] {
	const history = readJsonSettings().promptHistory;
	return Array.isArray(history)
		? history
				.filter(
					(item): item is string =>
						typeof item === "string" && item.trim().length > 0,
				)
				.slice(-MAX_PROMPT_HISTORY)
		: [];
}

export function savePromptHistory(history: readonly string[]): void {
	writeSettingsAtomically({
		...readJsonSettings(),
		promptHistory: history.slice(-MAX_PROMPT_HISTORY),
	});
}

/**
 * Load every custom theme from `<config root>/themes`. Files that fail to
 * decode, reserved `system`, and names that collide with built-ins are
 * reported and skipped so no bundled theme (or `system`) is overwritten.
 */
export function loadCustomThemes(): Record<string, ThemeJson> {
	const loaded: Record<string, ThemeJson> = {};
	const rejected: string[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(path.join(configDir(), "themes"), {
			withFileTypes: true,
		});
	} catch {
		setCustomThemes(loaded);
		return loaded;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const name = path.basename(entry.name, ".json");
		if (
			name === "system" ||
			name === "__proto__" ||
			Object.hasOwn(loaded, name) ||
			BUILTIN_THEME_NAMES.has(name)
		) {
			rejected.push(entry.name);
			continue;
		}
		try {
			const parsed = JSON.parse(
				fs.readFileSync(path.join(configDir(), "themes", entry.name), "utf8"),
			) as unknown;
			if (isThemeJson(parsed)) loaded[name] = parsed;
			else rejected.push(entry.name);
		} catch {
			rejected.push(entry.name);
		}
	}
	if (rejected.length)
		console.error(
			`[preferences] ignored custom themes: ${rejected.join(", ")}`,
		);
	setCustomThemes(loaded);
	return loaded;
}
