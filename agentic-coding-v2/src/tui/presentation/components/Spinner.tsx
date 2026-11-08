/** @jsxImportSource @opentui/solid */
// opencode's progress glyph: the ten-frame braille spinner, advanced every
// 80 ms. One module-level timer drives every mounted spinner, so a thinking row
// and several running tool rows share a frame instead of each allocating its
// own interval.
import { createSignal, onCleanup, onMount } from "solid-js";

/** The frames opencode v2 uses for `Spinner`. */
export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;
const FIRST_FRAME = "⠋";
const FRAME_MS = 80;

const [frame, setFrame] = createSignal(0);
let mounted = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** The current spinner glyph. Components call this on mount; the timer starts
 * with the first live spinner and stops with the last, so an idle transcript
 * keeps no animation timer. */
export function useSpinnerFrame(): () => string {
	let active = false;
	onMount(() => {
		active = true;
		mounted++;
		timer ??= setInterval(
			() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length),
			FRAME_MS,
		);
	});
	onCleanup(() => {
		// A cleanup can run for a component whose mount never happened; it must
		// not decrement another spinner's reference.
		if (!active) return;
		active = false;
		mounted--;
		if (mounted > 0 || timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	});
	return () => SPINNER_FRAMES[frame()] ?? FIRST_FRAME;
}

export interface SpinnerProps {
	readonly color?: string;
	readonly attributes?: number;
}

/** A one-cell braille spinner. The caller keeps the surrounding row's layout;
 * this component contributes only the animated glyph. */
export function Spinner(props: SpinnerProps) {
	const glyph = useSpinnerFrame();
	return (
		<text fg={props.color} attributes={props.attributes}>
			{glyph()}
		</text>
	);
}
