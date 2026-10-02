/** @jsxImportSource @opentui/solid */
// The prompt's top line: a thin aurora line that spans the full box width while
// the agent works, and stays blank otherwise, so the prompt never grows or
// shifts. It sits outside the input's horizontal padding, so the line reaches
// the box edges, and it replaces the blank top padding, so moving the status
// indicator "on top" costs no extra line.
//
// Each cell draws the top-eighth block glyph (`▔`) rather than filling the
// cell, so the highlight is a hairline across the top of the row and the
// input's line below keeps its full height.
import {
	type BoxRenderable,
	type OptimizedBuffer,
	parseColor,
	RGBA,
} from "@opentui/core";
import { useTimeline } from "@opentui/solid";
import {
	auroraColor,
	createAuroraPalette,
	DEFAULT_ANIMATION_HIGHLIGHTS,
	uiColors,
} from "@ui";

/** Upper one-eighth block: a thin line at the top of the cell. */
const TOP_LINE = "▔";
/** How far each aurora color is blended toward the prompt background: higher is
 * paler, so the line reads as a soft hint rather than a solid bar. */
const PALE = 0.55;

export interface PromptPulseProps {
	/** The agent is working: run the sweep. */
	readonly active: boolean;
	/** The newest generation failed: hold a static error-colored line. */
	readonly error?: boolean;
}

export function PromptPulse(props: PromptPulseProps) {
	const palette = createAuroraPalette(DEFAULT_ANIMATION_HIGHLIGHTS);
	const state = { progress: 0 };
	const timeline = useTimeline({ duration: 2000, loop: true });
	timeline.add(state, { progress: 1, duration: 2000, ease: "linear" });

	const renderAfter = function (this: BoxRenderable, buffer: OptimizedBuffer) {
		const width = this.width;
		if (width <= 0) return;
		const background = parseColor(uiColors.bgMantle);
		const pale = (color: RGBA) =>
			RGBA.fromValues(
				color.r + (background.r - color.r) * PALE,
				color.g + (background.g - color.g) * PALE,
				color.b + (background.b - color.b) * PALE,
				1,
			);
		const paint = (color: (index: number) => RGBA) => {
			for (let index = 0; index < width; index++) {
				buffer.setCell(
					this.screenX + index,
					this.screenY,
					TOP_LINE,
					color(index),
					background,
				);
			}
		};
		if (props.error) {
			const color = parseColor(uiColors.error);
			paint(() => color);
			return;
		}
		if (!props.active) return;
		// Ping-pong the aurora phase so the fade runs left→right and back rather
		// than restarting at the left.
		const pingPong =
			state.progress <= 0.5 ? state.progress * 2 : (1 - state.progress) * 2;
		paint((index) =>
			pale(
				auroraColor(palette, width <= 1 ? 0 : index / (width - 1), pingPong),
			),
		);
	};

	return (
		<box width="100%" height={1} flexShrink={0} renderAfter={renderAfter} />
	);
}
