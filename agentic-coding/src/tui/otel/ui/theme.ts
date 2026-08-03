// Shared theme state: all tabs follow the dashboard theme system, so a theme
// change in any tab applies everywhere. Single source: dash/ui/theme.ts.
export { themeColor, themeColorForTheme, themeNames, setActiveThemeName, getActiveThemeName, setCustomThemes, setSystemTheme, isThemeJson } from '../../dash/ui/theme.ts';
export type { ThemeJson } from '../../dash/ui/theme.ts';
