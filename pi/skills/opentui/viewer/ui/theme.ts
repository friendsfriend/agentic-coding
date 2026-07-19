import { createSignal } from 'solid-js';
import tokyonight from '../themes/tokyonight.json' with { type: 'json' };
import catppuccin from '../themes/catppuccin.json' with { type: 'json' };
import dracula from '../themes/dracula.json' with { type: 'json' };
import nord from '../themes/nord.json' with { type: 'json' };
import monokai from '../themes/monokai.json' with { type: 'json' };

type ThemeJson = {
  defs?: Record<string, string>;
  theme: Record<string, string | number | { dark: string; light: string } | undefined>;
};

const themeMap: Record<string, ThemeJson> = {
  'tokyo-night': tokyonight as ThemeJson,
  'catppuccin': catppuccin as ThemeJson,
  'dracula': dracula as ThemeJson,
  'nord': nord as ThemeJson,
  'monokai': monokai as ThemeJson,
};

export const themeNames = Object.keys(themeMap).sort();

const [activeThemeName, setActiveThemeNameSignal] = createSignal('tokyo-night');

export function setActiveThemeName(name: string): boolean {
  if (!themeMap[name]) return false;
  setActiveThemeNameSignal(name);
  return true;
}

export function getActiveThemeName(): string {
  return activeThemeName();
}

function activeTheme(): ThemeJson {
  return themeMap[activeThemeName()] ?? themeMap['tokyo-night']!;
}

function ansiToHex(code: number): string {
  const colors = ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];
  if (code < colors.length) return colors[code] ?? '#000000';
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return `#${[val(r), val(g), val(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const gray = Math.max(0, Math.min(255, (code - 232) * 10 + 8));
  const hex = gray.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

function resolveColor(theme: ThemeJson, key: string, fallback: string, mode: 'dark' | 'light' = 'dark', chain: string[] = []): string {
  const value = theme.theme[key];
  return resolveValue(theme, value, fallback, mode, chain);
}

function resolveValue(theme: ThemeJson, value: unknown, fallback: string, mode: 'dark' | 'light', chain: string[]): string {
  if (typeof value === 'number') return ansiToHex(value);
  if (typeof value === 'object' && value && 'dark' in value && 'light' in value) {
    return resolveValue(theme, (value as { dark: unknown; light: unknown })[mode], fallback, mode, chain);
  }
  if (typeof value !== 'string') return fallback;
  if (value === 'transparent' || value === 'none') return fallback;
  if (value.startsWith('#')) return value;
  if (chain.includes(value)) return fallback;
  return resolveValue(theme, theme.defs?.[value] ?? theme.theme[value], fallback, mode, [...chain, value]);
}

export function themeColor(key: string, fallback: string): string {
  return resolveColor(activeTheme(), key, fallback);
}
