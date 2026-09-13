// Terminal color capture for the `system` theme. Single source:
// src/tui/shared/terminal-theme.ts — capture goes through the OpenTUI renderer
// palette API (`renderer.getPalette`) with a bounded timeout; no manual OSC
// input reader is installed here.
export type { CapturedPalette } from "../../shared/terminal-theme";
export {
	applyCapturedSystemTheme,
	buildSystemTheme,
	captureRendererPalette,
	terminalColorsToThemeColors,
} from "../../shared/terminal-theme";
