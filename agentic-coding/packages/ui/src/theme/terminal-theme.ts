// Single renderer palette capture for the `system` theme. Both the workflow
// TUI and the environment TUI query the controlling terminal through the
// OpenTUI renderer's palette API (`renderer.getPalette`), never through a
// competing manual OSC input reader. Capture is bounded by a timeout; a
// timeout, a missing API or a headless run leaves `system` unregistered.
import type { TerminalColors } from "@opentui/core";
import { setSystemTheme, type ThemeJson } from "./theme";

/** ANSI 0–15 fallback used when the terminal does not answer. */
const ANSI_FALLBACK = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

/** A terminal palette normalized into concrete `#rrggbb` values. */
export interface CapturedPalette {
	/** ANSI palette entries 0–15, as `#rrggbb`. */
	ansi: string[];
	/** Terminal default foreground, as `#rrggbb` (OSC 10). */
	fg: string;
	/** Terminal default background, as `#rrggbb` (OSC 11). */
	bg: string;
}

/** Renderer palette answers normalized to `#rrggbb`, unchanged from devenv. */
export interface TerminalThemeColors {
	foreground?: string;
	background?: string;
	/** Palette entries kept by ANSI index; `undefined` for unanswered slots. */
	palette?: (string | undefined)[];
}

function normalizeHexColor(
	value: string | null | undefined,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^#?([0-9a-fA-F]{6})$/);
	return match ? `#${match[1]?.toLowerCase()}` : undefined;
}

function parseHex(color: string): [number, number, number] | null {
	const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(
		color,
	);
	if (!match) return null;
	return [
		parseInt(match[1], 16),
		parseInt(match[2], 16),
		parseInt(match[3], 16),
	];
}

function toHex(r: number, g: number, b: number): string {
	const channel = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function luminance(color: string): number {
	const rgb = parseHex(color);
	if (!rgb) return 0;
	return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** Mix `base` toward `target` by `t` (0–1); falls back to `base` on bad input. */
function blend(base: string, target: string, t: number): string {
	const from = parseHex(base);
	const to = parseHex(target);
	if (!from || !to) return base;
	const mix = (x: number, y: number) => x + (y - x) * t;
	return toHex(mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2]));
}

/**
 * Convert the renderer's terminal colors into indexed palette entries. Invalid
 * or unanswered slots stay `undefined` at their original index so a partial
 * capture never shifts surviving colors onto the wrong ANSI slot.
 */
export function terminalColorsToThemeColors(
	colors?: TerminalColors | null,
): TerminalThemeColors {
	if (!colors) return {};
	const palette = colors.palette
		.slice(0, 16)
		.map((color) => normalizeHexColor(color));

	return {
		foreground: normalizeHexColor(colors.defaultForeground),
		background: normalizeHexColor(colors.defaultBackground),
		palette: palette.length ? palette : undefined,
	};
}

/** Normalize renderer colors or an already-normalized answer into a palette. */
export function toCapturedPalette(
	colors?: TerminalColors | TerminalThemeColors | null,
): CapturedPalette | null {
	const normalized =
		colors && "defaultForeground" in colors
			? terminalColorsToThemeColors(colors)
			: (colors ?? {});
	const answer = normalized as TerminalThemeColors;
	const supplied = answer.palette ?? [];
	// A palette array is only meaningful when at least one slot answered; the
	// renderer returns an all-null 16-entry array on a headless/timed-out query.
	const hasCapturedColor = supplied.some((color) => color !== undefined);
	if (!hasCapturedColor && !answer.foreground && !answer.background)
		return null;
	// Fill each index from the ANSI fallback, not the tail, so an unanswered
	// slot 3 does not become captured slot 4.
	const ansi = Array.from(
		{ length: 16 },
		(_, index) => supplied[index] ?? ANSI_FALLBACK[index] ?? "#000000",
	);
	const bg =
		answer.background ??
		(process.env.COLORFGBG?.split(";").at(-1) === "15" ? "#ffffff" : "#000000");
	const fg = answer.foreground ?? (luminance(bg) > 0.6 ? "#111111" : "#eeeeee");
	return { ansi, fg, bg };
}

/**
 * Query the renderer for the terminal palette. Returns `null` when the
 * renderer exposes no palette API, the query rejects, or it resolves without
 * usable colors (headless runs). Never throws and never installs an input
 * listener of its own.
 */
export async function captureRendererPalette(
	renderer: {
		getPalette?: (options?: {
			size?: number;
			timeout?: number;
		}) => Promise<TerminalColors>;
	},
	timeoutMs = 300,
): Promise<CapturedPalette | null> {
	try {
		if (typeof renderer.getPalette !== "function") return null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), timeoutMs + 50);
		});
		const colors = await Promise.race([
			renderer.getPalette({ size: 16, timeout: timeoutMs }),
			deadline,
		]);
		clearTimeout(timer);
		if (!colors) return null;
		return toCapturedPalette(colors);
	} catch {
		return null;
	}
}

function deriveSurfaces(palette: CapturedPalette): {
	panel: string;
	element: string;
	border: string;
	borderActive: string;
	borderSubtle: string;
} {
	const { bg } = palette;
	const fg = palette.fg;
	const muted = palette.ansi[8] ?? bg;
	const target =
		fg !== bg
			? fg
			: muted !== bg
				? muted
				: luminance(bg) < 0.5
					? "#ffffff"
					: "#000000";
	return {
		panel: blend(bg, target, 0.06),
		element: blend(bg, target, 0.13),
		border: blend(bg, target, 0.25),
		borderActive: blend(bg, target, 0.42),
		borderSubtle: blend(bg, target, 0.1),
	};
}

/**
 * Map a captured palette into a ThemeJson of concrete hex values covering
 * every key the UI consumes (colors.ts/uiColors plus the diff/markdown/syntax
 * keys), so no resolved key falls back to a bundled-theme color.
 */
export function buildSystemTheme(palette: CapturedPalette): ThemeJson {
	const a = palette.ansi;
	const { fg, bg } = palette;
	const surfaces = deriveSurfaces(palette);
	return {
		theme: {
			primary: a[4],
			secondary: a[12],
			accent: a[5],
			error: a[1],
			warning: a[3],
			success: a[2],
			info: a[6],
			text: fg,
			textMuted: a[8],
			selectedListItemText: fg,
			background: bg,
			backgroundPanel: surfaces.panel,
			backgroundElement: surfaces.element,
			border: surfaces.border,
			borderActive: surfaces.borderActive,
			borderSubtle: surfaces.borderSubtle,
			diffAdded: a[2],
			diffRemoved: a[1],
			diffContext: a[8],
			diffHunkHeader: a[3],
			diffHighlightAdded: a[2],
			diffHighlightRemoved: a[1],
			diffAddedBg: blend(bg, a[2], 0.12),
			diffRemovedBg: blend(bg, a[1], 0.12),
			diffContextBg: surfaces.panel,
			diffLineNumber: a[8],
			diffAddedLineNumberBg: blend(bg, a[2], 0.08),
			diffRemovedLineNumberBg: blend(bg, a[1], 0.08),
			markdownText: fg,
			markdownHeading: a[5],
			markdownLink: a[4],
			markdownLinkText: a[6],
			markdownCode: a[2],
			markdownBlockQuote: a[3],
			markdownEmph: a[3],
			markdownStrong: a[3],
			markdownHorizontalRule: a[8],
			markdownListItem: a[4],
			markdownListEnumeration: a[6],
			markdownImage: a[4],
			markdownImageText: a[6],
			markdownCodeBlock: fg,
			syntaxComment: a[8],
			syntaxKeyword: a[5],
			syntaxFunction: a[4],
			syntaxVariable: a[1],
			syntaxString: a[2],
			syntaxNumber: a[3],
			syntaxType: a[3],
			syntaxOperator: a[6],
			syntaxPunctuation: fg,
		},
	};
}

/**
 * Capture and register the `system` theme in one step. No-op when capture
 * yields nothing, so a failed/headless capture never registers `system`.
 */
export async function applyCapturedSystemTheme(
	renderer: {
		getPalette?: (options?: {
			size?: number;
			timeout?: number;
		}) => Promise<TerminalColors>;
	},
	timeoutMs = 300,
): Promise<boolean> {
	const palette = await captureRendererPalette(renderer, timeoutMs);
	if (!palette) return false;
	setSystemTheme(buildSystemTheme(palette));
	return true;
}
