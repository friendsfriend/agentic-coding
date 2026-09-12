/** @jsxImportSource @opentui/solid */
import {
	type BoxRenderable,
	type OptimizedBuffer,
	RGBA,
	TextAttributes,
} from "@opentui/core";
import { useTimeline } from "@opentui/solid";
import { uiColors } from "../colors";
import { type Highlight, highlightColor } from "./Highlight";

export interface TextTransitionAnimationProps {
	from: string;
	to: string;
	fromHighlight?: Highlight;
	toHighlight?: Highlight;
	backgroundColor?: string;
	duration?: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (from: RGBA, to: RGBA, amount: number) =>
	RGBA.fromValues(
		from.r + (to.r - from.r) * amount,
		from.g + (to.g - from.g) * amount,
		from.b + (to.b - from.b) * amount,
		1,
	);

export function TextTransitionAnimation(props: TextTransitionAnimationProps) {
	const width = Math.max(1, props.from.length, props.to.length);
	const from = Array.from(props.from.padEnd(width));
	const to = Array.from(props.to.padEnd(width));
	const background = RGBA.fromHex(props.backgroundColor ?? uiColors.bgMantle);
	const fromColor = RGBA.fromHex(
		highlightColor(props.fromHighlight ?? "secondary"),
	);
	const toColor = RGBA.fromHex(
		highlightColor(props.toHighlight ?? "highlight1"),
	);
	const state = { progress: 0 };

	const timeline = useTimeline({
		duration: props.duration ?? 2600,
		loop: true,
	});
	timeline.add(state, {
		progress: 1,
		duration: props.duration ?? 2600,
		ease: "inOutSine",
	});

	const renderAfter = function renderAfter(
		this: BoxRenderable,
		buffer: OptimizedBuffer,
	) {
		const transition = 1 - Math.abs(state.progress * 2 - 1);

		from.forEach((oldCharacter, index) => {
			const local = clamp(transition * (width + 2) - index);
			const showingNew = local >= 0.5;
			const character = showingNew ? to[index] : oldCharacter;
			const foreground = mix(
				background,
				showingNew ? toColor : fromColor,
				Math.abs(local - 0.5) * 2,
			);

			buffer.setCell(
				this.screenX + index,
				this.screenY,
				character,
				foreground,
				background,
				TextAttributes.BOLD,
			);
		});
	};

	return (
		<box
			backgroundColor={props.backgroundColor ?? uiColors.bgMantle}
			renderAfter={renderAfter}
			style={{ width, height: 1, flexShrink: 0 }}
		/>
	);
}
