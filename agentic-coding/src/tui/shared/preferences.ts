// One local UI preferences adapter for every feature surface. The canonical
// file is `<config root>/tui.json`, where the root comes from the shared
// resolver: `AGENTIC_CODING_CONFIG_DIR`, then the deprecated
// `DEVENV_CONFIG_DIR`, then `~/.config/agentic-coding`.
// A canonical `theme` value always wins, even when it is not currently
// registered; only a canonical file with no `theme` key imports the legacy
// agentic-coding `[ui] theme` selection, once. Unrelated canonical keys are
// always preserved and writes are atomic so a failed save never corrupts the
// last good file. Workflow execution settings stay in their own
// provenance-aware config and are not touched here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigRoot } from "../../config-root.ts";
import {
	isThemeJson,
	setActiveThemeName,
	setCustomThemes,
	type ThemeJson,
	themeNames,
} from "./theme";

/** Directory that owns `tui.json` and the custom `themes/` folder. */
export function configDir(): string {
	return resolveConfigRoot();
}

/** Canonical local UI preferences file. */
export function themeSettingsPath(): string {
	return path.join(configDir(), "tui.json");
}

/** Legacy agentic-coding selection source, read only for one-time import. */
function legacyConfigPath(): string {
	return (
		process.env.HERDR_WORKFLOW_CONFIG ??
		path.join(os.homedir(), "dotfiles", "pi", "herdr-workflow.toml")
	);
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

/** Read the legacy `[ui] theme` value from the agentic-coding config. */
function readLegacyThemeName(): string | undefined {
	try {
		const parsed = Bun.TOML.parse(
			fs.readFileSync(legacyConfigPath(), "utf8"),
		) as { ui?: { theme?: unknown } };
		const theme = parsed.ui?.theme;
		return typeof theme === "string" ? theme : undefined;
	} catch {
		return undefined;
	}
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
		fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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
 * Resolve the active theme without modifying either settings file. A canonical
 * selection always wins over legacy, even when it is not currently registered
 * (e.g. a persisted `system` before capture, or a removed custom theme) so
 * startup never overwrites it. Only a canonical file with no `theme` key
 * imports the legacy selection, once, preserving unrelated canonical keys.
 * Otherwise the default `catppuccin` is returned.
 */
export function loadThemeName(): string {
	const canonical = readJsonSettings();
	if (canonical.theme !== undefined) {
		return isValidThemeName(canonical.theme) ? canonical.theme : "catppuccin";
	}

	const legacy = readLegacyThemeName();
	if (isValidThemeName(legacy)) {
		try {
			writeSettingsAtomically({ ...canonical, theme: legacy });
			return legacy;
		} catch {
			// An unwritable settings dir must not block startup or the import.
			return legacy;
		}
	}

	return "catppuccin";
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

/**
 * Load every custom theme from `$DEVENV_CONFIG_DIR/themes`. Files that fail to
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
