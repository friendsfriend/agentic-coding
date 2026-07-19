import { setActiveThemeName, getActiveThemeName, themeNames } from '../ui/theme';

export { themeNames };

export function loadThemeName(): string {
  return getActiveThemeName();
}

export function applyTheme(name: string): void {
  setActiveThemeName(name);
}
