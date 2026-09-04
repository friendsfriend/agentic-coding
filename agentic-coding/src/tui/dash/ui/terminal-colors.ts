// Terminal color capture for the `system` theme: query the controlling TTY
// with standard OSC color queries and map the replies into a ThemeJson of
// concrete hex values. One code path works for omarchy (where the terminal
// palette is omarchy-driven) and macOS terminal profiles, because OSC returns
// the terminal's effective colors in both cases. Capture is guarded to
// interactive TTY runs, bounded by a timeout, and restores the stdin mode it
// changed; any failure produces a typed `{ ok: false }` and no `system` entry.
import type { ThemeJson } from "./theme";

const OSC_START = "\x1b]";
const BEL = "\x07";
const ST = "\x1b\\";
const ANSI_COUNT = 16;
const FG_CODE = 10;
const BG_CODE = 11;
/** Expected reply targets; ANSI index 10/11 are distinct from OSC 10/11. */
const EXPECTED_KEYS = [
	...Array.from({ length: ANSI_COUNT }, (_, index) => `a${index}`),
	"fg",
	"bg",
];
const codeKey = (osc: number, code: number): string | null => {
	if (osc === FG_CODE) return "fg";
	if (osc === BG_CODE) return "bg";
	if (osc === 4 && code >= 0 && code <= ANSI_COUNT - 1) return `a${code}`;
	return null;
};
export const DEFAULT_CAPTURE_TIMEOUT_MS = 150;

export interface CapturedPalette {
	/** ANSI palette entries 0–15, as `#rrggbb`. */
	ansi: string[];
	/** Terminal default foreground, as `#rrggbb` (OSC 10). */
	fg: string;
	/** Terminal default background, as `#rrggbb` (OSC 11). */
	bg: string;
}

/**
 * One parsed OSC color reply. `osc` is the answering OSC query (4, 10, 11);
 * `code` is the ANSI index for OSC 4 replies and equals `osc` for 10/11,
 * which keeps ANSI index 10/11 distinct from the fg/bg queries.
 */
export interface OscReply {
	osc: 4 | 10 | 11;
	code: number;
	hex: string;
}

export type CaptureResult =
	| { ok: true; palette: CapturedPalette }
	| { ok: false };

/** Minimal byte source `process.stdin` satisfies and tests can fake. */
export interface ByteSource {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/**
 * Parse one complete OSC color reply (`ESC ] <code> ; rgb:RRRR/GGGG/BBBB`
 * terminated by BEL or ST) into its ANSI code and `#rrggbb` hex. Tolerates
 * both terminators and 8- or 16-bit-per-channel values; returns null for
 * malformed or partial input.
 */
export function parseOscReply(
	input: Buffer | Uint8Array | string,
): OscReply | null {
	const text =
		typeof input === "string" ? input : Buffer.from(input).toString("latin1");
	const start = text.indexOf(OSC_START);
	if (start === -1) return null;
	const body = text.slice(start + OSC_START.length);
	const bel = body.indexOf(BEL);
	const st = body.indexOf(ST);
	const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
	if (end === -1) return null;
	return parseOscPayload(body.slice(0, end));
}

function parseOscPayload(payload: string): OscReply | null {
	const fields = payload.split(";");
	let osc: OscReply["osc"];
	let code: number;
	let colorField: string | undefined;
	if (fields[0] === "4") {
		const index = Number(fields[1]);
		if (!Number.isInteger(index) || index < 0 || index > 255) return null;
		osc = 4;
		code = index;
		colorField = fields[2];
	} else if (fields[0] === String(FG_CODE) || fields[0] === String(BG_CODE)) {
		osc = fields[0] === String(FG_CODE) ? FG_CODE : BG_CODE;
		code = osc;
		colorField = fields[1];
	} else {
		return null;
	}
	if (!colorField) return null;
	const hex = parseOscColor(colorField);
	if (!hex) return null;
	return { osc, code, hex };
}

function parseOscColor(color: string): string | null {
	const match = /^rgba?:([0-9a-fA-F]+(?:\/[0-9a-fA-F]+){2,3})$/.exec(color);
	if (!match) return null;
	const components = match[1].split("/");
	if (components.length < 3) return null;
	// Each component is 2–4 hex digits; for 16-bit values the effective 8-bit
	// channel is the most significant byte (e.g. `cd00` → `cd`).
	const channels = components.slice(0, 3).map((component) => {
		if (component.length < 2 || component.length > 4) return undefined;
		return component.slice(0, 2);
	});
	if (channels.some((channel) => channel === undefined)) return null;
	return `#${channels.join("")}`.toLowerCase();
}

function buildPalette(seen: Map<string, string>): CapturedPalette {
	const ansi = Array.from(
		{ length: ANSI_COUNT },
		(_, index) => seen.get(`a${index}`) ?? "#000000",
	);
	return {
		ansi,
		fg: seen.get("fg") ?? ansi[7],
		bg: seen.get("bg") ?? ansi[0],
	};
}

/**
 * Read OSC color replies from a byte source until all expected codes arrive
 * or the timeout elapses. Resolves exactly once; removes its listener on the
 * way out so the source is left untouched.
 */
export function readTerminalPalette(
	source: ByteSource,
	timeoutMs: number,
): Promise<CaptureResult> {
	return new Promise((resolve) => {
		let settled = false;
		let pending = "";
		const seen = new Map<string, string>();
		const finish = (result: CaptureResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			source.removeListener("data", onData);
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
		const onData = (chunk: Buffer) => {
			pending += chunk.toString("latin1");
			const complete = () => {
				for (;;) {
					const start = pending.indexOf(OSC_START);
					if (start === -1) {
						pending = "";
						break;
					}
					const bodyStart = start + OSC_START.length;
					const bel = pending.indexOf(BEL, bodyStart);
					const st = pending.indexOf(ST, bodyStart);
					const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
					if (end === -1) {
						// Partial reply: keep from the OSC start, drop leading noise.
						pending = pending.slice(start);
						break;
					}
					const terminator = end === st ? ST : BEL;
					const reply = parseOscReply(
						pending.slice(start, end + terminator.length),
					);
					pending = pending.slice(end + terminator.length);
					if (reply) {
						const key = codeKey(reply.osc, reply.code);
						if (key) seen.set(key, reply.hex);
					}
				}
				return EXPECTED_KEYS.every((key) => seen.has(key));
			};
			if (complete()) finish({ ok: true, palette: buildPalette(seen) });
		};
		source.on("data", onData);
	});
}

/**
 * Capture the terminal's configured colors from the controlling TTY. Skips
 * (with `{ ok: false }`) when either end is not an interactive TTY. Snapshots
 * the stdin raw mode, enables raw mode for the query window, writes OSC 4
 * (ANSI 0–15), OSC 10 (fg) and OSC 11 (bg) queries, and restores the prior
 * mode once all replies arrive or the timeout elapses — never leaving stdin
 * hanging.
 */
export async function captureTerminalColors(
	timeoutMs: number = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<CaptureResult> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return { ok: false };
	const stdin = process.stdin;
	const priorRaw = stdin.isRaw;
	try {
		stdin.setRawMode(true);
	} catch {
		return { ok: false };
	}
	stdin.resume();
	const queries = [
		...Array.from(
			{ length: ANSI_COUNT },
			(_, index) => `${OSC_START}4;${index};?${BEL}`,
		),
		`${OSC_START}${FG_CODE};?${BEL}`,
		`${OSC_START}${BG_CODE};?${BEL}`,
	].join("");
	try {
		process.stdout.write(queries);
	} catch {
		// Broken pipe or closed TTY: restore stdin and degrade to no capture.
		stdin.pause();
		try {
			stdin.setRawMode(priorRaw);
		} catch {
			// Best-effort restore; the renderer sets its own mode next anyway.
		}
		return { ok: false };
	}
	const result = await readTerminalPalette(stdin, timeoutMs);
	stdin.pause();
	try {
		stdin.setRawMode(priorRaw);
	} catch {
		// Best-effort restore; the renderer sets its own mode next anyway.
	}
	return result;
}

// ---- Palette → ThemeJson mapping -------------------------------------------

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

/** Derive surfaces/borders as deterministic steps toward the palette's light end. */
function deriveSurfaces(palette: CapturedPalette): {
	panel: string;
	element: string;
	border: string;
	borderActive: string;
	borderSubtle: string;
} {
	const { bg } = palette;
	const fg = palette.fg;
	const muted = palette.ansi[8];
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
