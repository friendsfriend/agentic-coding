import { describe, expect, it } from 'bun:test';
import { themeColorForTheme, themeNames } from '../theme';

describe('theme picker colors', () => {
  it('returns each theme swatch color and a fallback for unknown themes', () => {
    expect(themeNames).toHaveLength(33);
    expect(themeNames).toEqual(expect.arrayContaining(['aura', 'catppuccin-frappe', 'tokyonight', 'zenburn']));
    expect(themeColorForTheme('dracula', 'primary', 'fallback')).not.toBe('fallback');
    expect(themeColorForTheme('missing', 'primary', 'fallback')).toBe('fallback');
  });
});
