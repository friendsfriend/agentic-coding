import type { TextChunk } from "@opentui/core";
import { RGBA, StyledText, TextAttributes } from "@opentui/core";

// ANSI control characters are referenced through their code points so the
// regular expressions below stay free of literal control characters.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// ANSI 16-colour palette: indices 0–7 dark, 8–15 bright
const ANSI_16: readonly [number, number, number][] = [
	[0, 0, 0],
	[170, 0, 0],
	[0, 170, 0],
	[170, 85, 0],
	[0, 0, 170],
	[170, 0, 170],
	[0, 170, 170],
	[170, 170, 170],
	[85, 85, 85],
	[255, 85, 85],
	[85, 255, 85],
	[255, 255, 85],
	[85, 85, 255],
	[255, 85, 255],
	[85, 255, 255],
	[255, 255, 255],
];

function buildColorCube(): [number, number, number][] {
	const cube: [number, number, number][] = [];
	for (let r = 0; r < 6; r++)
		for (let g = 0; g < 6; g++)
			for (let b = 0; b < 6; b++)
				cube.push([
					r ? r * 40 + 55 : 0,
					g ? g * 40 + 55 : 0,
					b ? b * 40 + 55 : 0,
				]);
	return cube;
}

function buildGreyscale(): [number, number, number][] {
	const ramp: [number, number, number][] = [];
	for (let i = 0; i < 24; i++) {
		const v = 8 + i * 10;
		ramp.push([v, v, v]);
	}
	return ramp;
}

const PALETTE_256: readonly [number, number, number][] = [
	...ANSI_16,
	...buildColorCube(),
	...buildGreyscale(),
];

function rgba256(index: number): RGBA {
	const entry = PALETTE_256[Math.max(0, Math.min(255, index))];
	return RGBA.fromInts(entry[0], entry[1], entry[2]);
}

interface SgrState {
	fg: RGBA | undefined;
	bg: RGBA | undefined;
	attributes: number;
}

function defaultState(): SgrState {
	return { fg: undefined, bg: undefined, attributes: TextAttributes.NONE };
}

function applySgr(params: number[], state: SgrState): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i++];

		if (code === 0) {
			const fresh = defaultState();
			state.fg = fresh.fg;
			state.bg = fresh.bg;
			state.attributes = fresh.attributes;
			continue;
		}

		// 256-colour fg (38;5;N) or truecolour fg (38;2;R;G;B)
		if (code === 38) {
			if (params[i] === 5 && i + 1 < params.length) {
				i++;
				state.fg = rgba256(params[i++]);
			} else if (params[i] === 2 && i + 3 < params.length) {
				i++;
				state.fg = RGBA.fromInts(params[i++], params[i++], params[i++]);
			} else {
				i++;
			}
			continue;
		}

		// 256-colour bg (48;5;N) or truecolour bg (48;2;R;G;B)
		if (code === 48) {
			if (params[i] === 5 && i + 1 < params.length) {
				i++;
				state.bg = rgba256(params[i++]);
			} else if (params[i] === 2 && i + 3 < params.length) {
				i++;
				state.bg = RGBA.fromInts(params[i++], params[i++], params[i++]);
			} else {
				i++;
			}
			continue;
		}

		// SGR fg/bg colour codes and text attribute codes
		if (code >= 30 && code <= 37) {
			state.fg = rgba256(code - 30);
			continue;
		}
		if (code === 39) {
			state.fg = undefined;
			continue;
		}
		if (code >= 40 && code <= 47) {
			state.bg = rgba256(code - 40);
			continue;
		}
		if (code === 49) {
			state.bg = undefined;
			continue;
		}
		if (code >= 90 && code <= 97) {
			state.fg = rgba256(code - 90 + 8);
			continue;
		}
		if (code >= 100 && code <= 107) {
			state.bg = rgba256(code - 100 + 8);
			continue;
		}

		if (code === 1) {
			state.attributes |= TextAttributes.BOLD;
			continue;
		}
		if (code === 2) {
			state.attributes |= TextAttributes.DIM;
			continue;
		}
		if (code === 3) {
			state.attributes |= TextAttributes.ITALIC;
			continue;
		}
		if (code === 4) {
			state.attributes |= TextAttributes.UNDERLINE;
			continue;
		}
		if (code === 5) {
			state.attributes |= TextAttributes.BLINK;
			continue;
		}
		if (code === 7) {
			state.attributes |= TextAttributes.INVERSE;
			continue;
		}
		if (code === 9) {
			state.attributes |= TextAttributes.STRIKETHROUGH;
			continue;
		}

		if (code === 22) {
			state.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
			continue;
		}
		if (code === 23) {
			state.attributes &= ~TextAttributes.ITALIC;
			continue;
		}
		if (code === 24) {
			state.attributes &= ~TextAttributes.UNDERLINE;
			continue;
		}
		if (code === 25) {
			state.attributes &= ~TextAttributes.BLINK;
			continue;
		}
		if (code === 27) {
			state.attributes &= ~TextAttributes.INVERSE;
			continue;
		}
		if (code === 29) {
			state.attributes &= ~TextAttributes.STRIKETHROUGH;
		}
	}
}

// Matches CSI SGR:  ESC [ <params> m
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

function stripNonSgrEscapes(text: string): string {
	if (!text.includes(ESC)) return text;
	return text
		.replace(new RegExp(`${ESC}\\[[0-9;]*[A-HJ-Za-z]`, "g"), "") // CSI non-SGR
		.replace(
			new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
			"",
		) // OSC  ESC ] ... ST|BEL
		.replace(new RegExp(`${ESC}[^\\[\\]]`, "g"), ""); // bare ESC + char
}

function makeChunk(text: string, state: SgrState): TextChunk {
	const chunk: TextChunk = { __isChunk: true, text };
	if (state.fg !== undefined) chunk.fg = state.fg;
	if (state.bg !== undefined) chunk.bg = state.bg;
	if (state.attributes !== TextAttributes.NONE)
		chunk.attributes = state.attributes;
	return chunk;
}

export function ansiToStyledText(text: string): StyledText | null {
	if (!text.includes(ESC)) return null;

	const chunks: TextChunk[] = [];
	const state = defaultState();
	let lastIndex = 0;

	SGR_RE.lastIndex = 0;
	for (;;) {
		const match = SGR_RE.exec(text);
		if (match === null) break;
		if (match.index > lastIndex) {
			const clean = stripNonSgrEscapes(text.slice(lastIndex, match.index));
			if (clean.length > 0) chunks.push(makeChunk(clean, state));
		}
		lastIndex = match.index + match[0].length;

		const raw = match[1];
		applySgr(raw.length === 0 ? [0] : raw.split(";").map(Number), state);
	}

	if (lastIndex < text.length) {
		const clean = stripNonSgrEscapes(text.slice(lastIndex));
		if (clean.length > 0) chunks.push(makeChunk(clean, state));
	}

	return chunks.length === 0 ? null : new StyledText(chunks);
}

export function stripAnsi(text: string): string {
	if (!text.includes(ESC)) return text;
	return text
		.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "") // CSI  ESC [ ... <letter>
		.replace(
			new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
			"",
		) // OSC  ESC ] ... ST|BEL
		.replace(new RegExp(`${ESC}[^\\[\\]]`, "g"), ""); // bare ESC + char
}
