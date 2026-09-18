// Theme persistence shared with the dashboard (same config file, same state).

export { getActiveThemeName, themeNames } from "@ui";
export {
	applyTheme,
	loadThemeName,
	saveThemeName,
} from "../../dash/theme-settings.ts";
