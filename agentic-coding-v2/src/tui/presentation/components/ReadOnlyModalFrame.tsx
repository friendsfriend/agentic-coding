/** @jsxImportSource @opentui/solid */
import { type MouseEvent, RGBA } from "@opentui/core";
import { Portal } from "@opentui/solid";
import { createEffect, type JSX, onCleanup } from "solid-js";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors.ts";
import {
	classifyPointerGesture,
	isPrimaryPointerButton,
	type PointerSample,
} from "./mouse/clickSemantics.ts";

/** Original GenericModal read-only framing branch, shared locally without
 * editor/confirmation state, native commands, global selection or clipboard hooks.
 * Sizing and chrome content remain owned by the original calling surface. */
export function ReadOnlyModalFrame(props: {
	width: number;
	height: number;
	header: JSX.Element;
	footer: JSX.Element;
	footerHeight: number;
	children: JSX.Element;
	close: () => void;
	active?: boolean;
}) {
	const dimensions = useTerminalDimensions();
	const onBackdropArea = (event: MouseEvent) =>
		event.target === undefined || event.target === event.currentTarget;
	let backdropDown: PointerSample | undefined;
	let disposed = false;
	const enabled = () => !disposed && props.active !== false;
	createEffect(() => {
		props.active;
		dimensions();
		backdropDown = undefined;
	});
	onCleanup(() => {
		disposed = true;
		backdropDown = undefined;
	});
	const backdropMouseDown = (event: MouseEvent) => {
		backdropDown = undefined;
		if (
			!enabled() ||
			!isPrimaryPointerButton(event.button) ||
			!onBackdropArea(event)
		)
			return;
		backdropDown = { x: event.x, y: event.y };
	};
	const backdropMouseUp = (event: MouseEvent) => {
		const start = backdropDown;
		backdropDown = undefined;
		if (
			!enabled() ||
			!isPrimaryPointerButton(event.button) ||
			!onBackdropArea(event)
		)
			return;
		if (classifyPointerGesture(start, { x: event.x, y: event.y }) !== "tap")
			return;
		props.close();
		event.stopPropagation();
	};
	return (
		<Portal
			ref={(el) => {
				const portal = el as { position?: string; zIndex?: number };
				portal.position = "absolute";
				portal.zIndex = 100;
			}}
		>
			<box
				position="absolute"
				top={0}
				left={0}
				width={dimensions().width}
				height={dimensions().height}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
				backgroundColor={RGBA.fromValues(0, 0, 0, 0.35)}
				onMouseDown={backdropMouseDown}
				onMouseUp={backdropMouseUp}
				onMouseScroll={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<box
					backgroundColor={uiColors.bgMantle}
					width={props.width}
					height={props.height}
					flexDirection="column"
					paddingTop={1}
					paddingBottom={1}
					paddingLeft={2}
					paddingRight={2}
					onMouseUp={(event) => event.stopPropagation()}
				>
					{props.header}
					{props.children}
					<box
						width="100%"
						height={props.footerHeight}
						justifyContent="flex-start"
						flexDirection="column"
						flexShrink={0}
					>
						{props.footer}
					</box>
				</box>
			</box>
		</Portal>
	);
}
