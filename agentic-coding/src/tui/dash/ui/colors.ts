import { themeColor } from './theme';
// Single source of truth for every color in the TUI. All colors come from the
// selected theme; fallbacks are theme-derived (neighboring keys of the same
// theme), never a baked-in palette. The only literals are the terminal's
// neutral defaults, used just for the two root keys when a theme lacks them.
const rootText = () => themeColor('text', '#ffffff');
const rootBg = () => themeColor('background', '#000000');
const theme = (key: string, fallbackKey: string = 'text') => themeColor(key, fallbackKey === 'text' ? rootText() : themeColor(fallbackKey, rootText()));

/** Semantic palette — theme-sourced names used by components. */
export const colors = {
  get red() { return theme('error'); },
  get peach() { return theme('warning'); },
  get yellow() { return theme('warning'); },
  get green() { return theme('success'); },
  get teal() { return theme('info'); },
  get sky() { return theme('info'); },
  get blue() { return theme('primary'); },
  get lavender() { return theme('accent'); },
  get mauve() { return theme('accent'); },
  get sapphire() { return theme('secondary'); },
  get text() { return rootText(); },
  get subtext1() { return theme('textMuted'); },
  get subtext0() { return theme('textMuted'); },
  get overlay2() { return theme('textMuted'); },
  get overlay1() { return theme('border'); },
  get overlay0() { return theme('borderSubtle'); },
  get surface2() { return theme('borderSubtle'); },
  get surface1() { return theme('backgroundElement'); },
  get surface0() { return theme('backgroundPanel'); },
  get base() { return rootBg(); },
  get mantle() { return theme('backgroundPanel'); },
  get crust() { return theme('backgroundElement'); },
} as const;

export const uiColors = {
  get primary() { return theme('primary'); },
  get primaryDim() { return theme('secondary'); },
  get success() { return theme('success'); },
  get warning() { return theme('warning'); },
  get error() { return theme('error'); },
  get info() { return theme('info'); },
  get highlight() { return theme('accent'); },
  get accent() { return theme('accent'); },

  get textPrimary() { return rootText(); },
  get textSecondary() { return theme('textMuted'); },
  get textTertiary() { return theme('textMuted'); },
  get textMuted() { return theme('textMuted'); },

  get bgBase() { return rootBg(); },
  get bgMantle() { return theme('backgroundPanel'); },
  get bgCrust() { return theme('backgroundElement'); },
  get bgSurface0() { return theme('backgroundPanel'); },
  get bgSurface1() { return theme('backgroundElement'); },
  get bgSurface2() { return theme('borderSubtle'); },

  get border() { return theme('border'); },
  get borderFocus() { return theme('borderActive'); },
  get borderHighlight() { return theme('borderActive'); },

  get selectionBg() { return theme('primary'); },
  get selectionBgActive() { return theme('accent'); },
  get selectionText() { return theme('selectedListItemText', 'text'); },

  get scrollbarTrack() { return theme('backgroundElement'); },
  get scrollbarThumb() { return theme('border'); },

  get diffAdded() { return theme('diffAdded'); },
  get diffRemoved() { return theme('diffRemoved'); },
  get diffContext() { return theme('diffContext'); },
  get diffAddedBg() { return theme('diffAddedBg', 'backgroundPanel'); },
  get diffRemovedBg() { return theme('diffRemovedBg', 'backgroundPanel'); },
  get diffContextBg() { return theme('diffContextBg', 'backgroundPanel'); },
} as const;

export type CatppuccinColor = keyof typeof colors;
export type UIColor = keyof typeof uiColors;

/** Shared scrollbar options — colors resolved from the active theme at use time. */
export const SCROLLBAR_OPTIONS = {
  showArrows: false,
  trackOptions: {
    get backgroundColor() { return uiColors.bgSurface0; },
    get foregroundColor() { return uiColors.scrollbarThumb; },
  },
} as const;
