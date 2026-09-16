// Dashboard theme preferences — one adapter for every surface. Single source:
// src/tui/shared/preferences.ts (canonical `$AGENTIC_CODING_CONFIG_DIR/tui.json`).
export {
	applyTheme,
	configDir,
	loadCustomThemes,
	loadThemeName,
	saveThemeName,
	themeSettingsPath,
	writeSettingsAtomically,
} from "../shared/preferences";
