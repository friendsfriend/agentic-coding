/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid";
import { createMemo } from "solid-js";

export interface RunningTextProps {
	text: string;
	width?: number;
	enabled?: boolean;
	active?: boolean;
	offset?: number;
	align?: "left" | "right";
	fg?: string;
	attributes?: number;
	resetKey?: string | number;
}

export function runningTextFrame(
	text: string,
	width: number,
	enabled: boolean,
	active: boolean,
	offset: number,
	delayTicks = 13,
	endHoldTicks = 13,
	align: "left" | "right" = "left",
): string {
	if (width <= 0) return "";

	if (align === "right") {
		if (text.length <= width) return text.padStart(width, " ");

		const initial =
			width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
		if (!enabled || !active) return initial;

		const maxScroll = Math.max(0, text.length - width);
		const cycleTicks = delayTicks + maxScroll + endHoldTicks;
		const phase = cycleTicks > 0 ? offset % cycleTicks : 0;

		if (phase < delayTicks) return initial;

		const scrollOffset = phase - delayTicks;
		if (scrollOffset >= maxScroll) return text.slice(text.length - width);

		return text.slice(scrollOffset, scrollOffset + width);
	}

	const textWidth = Math.max(0, width - 1);
	const withTrailingSpace = (value: string) => `${value.slice(0, textWidth)} `;

	if (textWidth === 0) return " ";
	if (text.length <= textWidth) return withTrailingSpace(text);

	const initial =
		textWidth <= 1
			? text.slice(0, textWidth)
			: `${text.slice(0, textWidth - 1)}…`;
	if (!enabled || !active) return withTrailingSpace(initial);

	const maxScroll = Math.max(0, text.length - textWidth);
	const cycleTicks = delayTicks + maxScroll + endHoldTicks;
	const phase = cycleTicks > 0 ? offset % cycleTicks : 0;

	if (phase < delayTicks) return withTrailingSpace(initial);

	const scrollOffset = phase - delayTicks;
	if (scrollOffset >= maxScroll)
		return withTrailingSpace(text.slice(text.length - textWidth));

	return withTrailingSpace(text.slice(scrollOffset, scrollOffset + textWidth));
}

export function RunningText(props: RunningTextProps) {
	const dimensions = useTerminalDimensions();
	const width = createMemo(() =>
		Math.max(0, props.width ?? dimensions().width),
	);
	let startOffset = props.offset ?? 0;
	let previousResetToken = "";

	const content = createMemo(() => {
		const text = props.text ?? "";
		const currentWidth = width();
		const enabled = props.enabled ?? false;
		const active = props.active ?? false;
		const currentOffset = props.offset ?? 0;
		const alignment = props.align ?? "left";
		const resetToken = `${enabled}|${active}|${text}|${currentWidth}|${alignment}|${props.resetKey ?? ""}`;
		if (resetToken !== previousResetToken) {
			previousResetToken = resetToken;
			startOffset = currentOffset;
		}
		const relativeOffset = Math.max(0, currentOffset - startOffset);
		return runningTextFrame(
			text,
			currentWidth,
			enabled,
			active,
			relativeOffset,
			13,
			13,
			alignment,
		);
	});

	return (
		<text fg={props.fg} attributes={props.attributes}>
			{content()}
		</text>
	);
}
