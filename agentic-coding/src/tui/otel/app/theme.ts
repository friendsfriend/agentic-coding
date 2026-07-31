import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getActiveThemeName, setActiveThemeName, themeNames } from '../ui/theme';

export { getActiveThemeName, themeNames };

const configPath = () => process.env.HERDR_WORKFLOW_CONFIG ?? resolve(process.env.HOME ?? '~', 'dotfiles/pi/herdr-workflow.toml');

export function loadThemeName(): string {
  try {
    const match = readFileSync(configPath(), 'utf8').match(/\[ui\][\s\S]*?^theme\s*=\s*"([^"]+)"/m);
    return match?.[1] && themeNames.includes(match[1]) ? match[1] : 'tokyonight';
  } catch {
    return 'tokyonight';
  }
}

export const applyTheme = (name: string) => setActiveThemeName(name);

export function saveThemeName(name: string) {
  const path = configPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = /\[ui\]/.test(text)
    ? (/\[ui\][\s\S]*?^theme\s*=.*$/m.test(text) ? text.replace(/(\[ui\][\s\S]*?^theme\s*=).*$/m, `$1 "${name}"`) : text.replace('[ui]', `[ui]\ntheme = "${name}"`))
    : `${text.trimEnd()}\n\n[ui]\ntheme = "${name}"\n`;
  writeFileSync(path, next);
}
