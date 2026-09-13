// Environment TUI theme preferences — one adapter for every surface. Single
// source: src/tui/shared/preferences.ts (canonical `$DEVENV_CONFIG_DIR/tui.json`)
// plus src/tui/shared/terminal-theme.ts for renderer palette capture/mapping.
import type { TerminalColors } from "@opentui/core";
import {
	applyTheme,
	loadCustomThemes,
	loadThemeName,
	saveThemeName,
} from "../../../../../src/tui/shared/preferences";
import {
	buildSystemTheme,
	type TerminalThemeColors,
	terminalColorsToThemeColors,
	toCapturedPalette,
} from "../../../../../src/tui/shared/terminal-theme";
import { setSystemTheme } from "../../../../../src/tui/shared/theme";

export type { TerminalThemeColors };
export {
	applyTheme,
	loadCustomThemes,
	loadThemeName,
	saveThemeName,
	terminalColorsToThemeColors,
};

/**
 * Query the renderer palette API with a bounded timeout. Returns `{}` for a
 * missing API or a failed/timed-out query so callers fall back cleanly.
 */
export async function loadRendererThemeColors(
	renderer: {
		getPalette?: (options?: {
			size?: number;
			timeout?: number;
		}) => Promise<TerminalColors>;
	},
	timeoutMs = 300,
): Promise<TerminalThemeColors> {
	try {
		if (typeof renderer.getPalette !== "function") return {};
		return terminalColorsToThemeColors(
			await renderer.getPalette({ size: 16, timeout: timeoutMs }),
		);
	} catch {
		return {};
	}
}

/**
 * Register the captured palette as the `system` theme. A failed or empty
 * capture is a no-op, so `system` is only offered after a valid capture.
 */
export function loadSystemTheme(colors: TerminalThemeColors = {}): void {
	const palette = toCapturedPalette(colors);
	if (palette) setSystemTheme(buildSystemTheme(palette));
}
