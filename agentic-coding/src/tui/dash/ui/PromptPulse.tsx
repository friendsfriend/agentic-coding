/** @jsxImportSource @opentui/solid */
// The prompt's top line: a soft highlight pulse that spreads from the center
// toward both edges while the agent works, and stays blank otherwise, so it never grows or
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
import { uiColors } from "@ui";
import { createEffect } from "solid-js";

/** Upper one-eighth block: a thin line at the top of the cell. */
const TOP_LINE = "▔";
const PULSE_MS = 2400;
const REST_INTENSITY = 0.06;
const PEAK_INTENSITY = 0.65;
const PULSE_WIDTH = 0.4;

/** A mirrored, smooth-edged wave: center peaks first, edges last. Both cycle
 * endpoints rest at the same dim level, so the loop never flashes or reverses. */
export function promptPulseIntensity(
	position: number,
	progress: number,
): number {
	if (!Number.isFinite(position) || !Number.isFinite(progress))
		return REST_INTENSITY;
	const distance = Math.abs(Math.max(0, Math.min(1, position)) * 2 - 1);
	const front =
		Math.max(0, Math.min(1, progress)) * (1 + 2 * PULSE_WIDTH) - PULSE_WIDTH;
	const band = Math.max(0, 1 - Math.abs(distance - front) / PULSE_WIDTH);
	const smooth = band * band * (3 - 2 * band);
	return Math.min(
		PEAK_INTENSITY,
		REST_INTENSITY + (PEAK_INTENSITY - REST_INTENSITY) * smooth,
	);
}

export interface PromptPulseProps {
	/** The agent is working: pulse outward from the center. */
	readonly active: boolean;
	/** The newest generation failed: hold a static error-colored line. */
	readonly error?: boolean;
}

export function PromptPulse(props: PromptPulseProps) {
	const state = { progress: 0 };
	const timeline = useTimeline({
		duration: PULSE_MS,
		loop: true,
		autoplay: false,
	});
	timeline.add(state, { progress: 1, duration: PULSE_MS, ease: "linear" });
	createEffect(() => {
		if (props.active && !props.error) timeline.play();
		else timeline.pause();
	});

	const renderAfter = function (this: BoxRenderable, buffer: OptimizedBuffer) {
		const width = this.width;
		if (width <= 0) return;
		const background = parseColor(uiColors.bgMantle);
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
		// Resolve theme colors per paint so changing themes also changes the pulse.
		const highlight = parseColor(uiColors.highlight);
		paint((index) => {
			const intensity = promptPulseIntensity(
				width <= 1 ? 0.5 : index / (width - 1),
				state.progress,
			);
			return RGBA.fromValues(
				background.r + (highlight.r - background.r) * intensity,
				background.g + (highlight.g - background.g) * intensity,
				background.b + (highlight.b - background.b) * intensity,
				1,
			);
		});
	};

	return (
		<box width="100%" height={1} flexShrink={0} renderAfter={renderAfter} />
	);
}
