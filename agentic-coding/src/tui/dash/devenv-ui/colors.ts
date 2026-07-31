import { themeColor } from './theme';

/**
 * Catppuccin Mocha Color Palette
 * https://github.com/catppuccin/catppuccin
 * 
 * A soothing pastel theme for terminals and applications
 */

export const colors = {
  // Accent Colors
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',

  // Text Colors
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',

  // Overlay Colors
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',

  // Surface Colors
  surface2: '#585b70',
  surface1: '#45475a',
  surface0: '#313244',

  // Base Colors
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
} as const;

/**
 * Common UI element colors mapped to active OpenCode-compatible theme.
 */
export const uiColors = {
  get primary() { return themeColor('primary', colors.blue); },
  get primaryDim() { return themeColor('secondary', colors.sapphire); },

  get success() { return themeColor('success', colors.green); },
  get warning() { return themeColor('warning', colors.yellow); },
  get error() { return themeColor('error', colors.red); },
  get info() { return themeColor('info', colors.sky); },

  get highlight() { return themeColor('accent', colors.mauve); },
  get accent() { return themeColor('accent', colors.lavender); },

  get textPrimary() { return themeColor('text', colors.text); },
  get textSecondary() { return themeColor('textMuted', colors.subtext1); },
  get textTertiary() { return themeColor('textMuted', colors.subtext0); },
  get textMuted() { return themeColor('textMuted', colors.overlay2); },

  get bgBase() { return themeColor('background', colors.base); },
  get bgMantle() { return themeColor('backgroundPanel', colors.mantle); },
  get bgCrust() { return themeColor('background', colors.crust); },
  get bgSurface0() { return themeColor('backgroundElement', colors.surface0); },
  get bgSurface1() { return themeColor('backgroundMenu', colors.surface1); },
  get bgSurface2() { return themeColor('borderSubtle', colors.surface2); },

  get border() { return themeColor('border', colors.surface2); },
  get borderFocus() { return themeColor('borderActive', colors.blue); },
  get borderHighlight() { return themeColor('borderActive', colors.lavender); },

  get selectionBg() { return themeColor('primary', colors.surface1); },
  get selectionBgActive() { return themeColor('accent', colors.surface2); },
  get selectionText() { return themeColor('selectedListItemText', colors.text); },

  get scrollbarTrack() { return themeColor('backgroundElement', colors.surface0); },
  get scrollbarThumb() { return themeColor('border', colors.overlay0); },

  get diffAdded() { return themeColor('diffAdded', colors.green); },
  get diffRemoved() { return themeColor('diffRemoved', colors.red); },
  get diffContext() { return themeColor('diffContext', colors.overlay2); },
  get diffAddedBg() { return themeColor('diffAddedBg', '#24312b'); },
  get diffRemovedBg() { return themeColor('diffRemovedBg', '#3c2a32'); },
  get diffContextBg() { return themeColor('diffContextBg', colors.mantle); },
} as const;

export type CatppuccinColor = keyof typeof colors;
export type UIColor = keyof typeof uiColors;

/**
 * Shared scrollbar options for all native <scrollbox> elements.
 * Pass directly as scrollbarOptions={SCROLLBAR_OPTIONS}.
 *
 * Track background : surface0  (#313244) — blends into dark backgrounds
 * Thumb foreground  : overlay0  (#6c7086) — visible but not distracting
 *
 * NOTE: `visible` is intentionally omitted here so that each scrollbar
 * auto-manages its own visibility via recalculateVisibility().
 * Forcing visible:true on the shared options would also make the
 * horizontal scrollbar permanently visible (as a 1-line grey strip at
 * the bottom of every panel) even when there is nothing to scroll
 * horizontally, because both scrollbars receive scrollbarOptions.
 */
export const SCROLLBAR_OPTIONS = {
  showArrows: false,
  trackOptions: {
    backgroundColor: colors.surface0,
    foregroundColor: colors.overlay0,
  },
} as const;
