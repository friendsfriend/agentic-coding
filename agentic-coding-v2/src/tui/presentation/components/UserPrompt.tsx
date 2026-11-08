/** @jsxImportSource @opentui/solid */

import type { BoxRenderable } from "@opentui/core";
import {
	createEffect,
	createUniqueId,
	onCleanup,
	onMount,
	useContext,
} from "solid-js";
import { ActionRegistry } from "../../ui/ActionHeader.tsx";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { useTap } from "./mouse/useTap.ts";
import { Stamp } from "./Stamp.tsx";

/** Original UserPrompt presentation, with text/folding supplied by the native
 * caller instead of the legacy AgentSessionBlock contract. */
export function UserPrompt(props: {
	text: string;
	timestamp?: unknown;
	expanded: boolean;
	onToggle: () => void;
	anchor?: (node: BoxRenderable | null) => void;
	scope?: unknown;
	interactive?: boolean;
	keyboard?: boolean;
}) {
	const anchor = props.anchor,
		registry = useContext(ActionRegistry),
		id = createUniqueId();
	const gesture: RowGestureState = {};
	let node: BoxRenderable | undefined,
		disposed = false,
		unregister: (() => void) | undefined;
	const retire = () => {
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	createEffect(() => {
		props.text;
		props.scope;
		props.interactive;
		retire();
	});
	const activate = () => {
		if (!disposed && props.interactive !== false) props.onToggle();
	};
	onMount(() => {
		if (props.keyboard)
			unregister = registry?.register({ id, node: () => node, activate });
	});
	onCleanup(() => {
		disposed = true;
		retire();
		unregister?.();
		anchor?.(null);
	});
	const tap = useTap(
		() => {
			if (props.keyboard) registry?.select(id);
			activate();
		},
		{
			gesture,
			stopPropagation: true,
			enabled: () => !disposed && props.interactive !== false,
		},
	);
	const hover = useHover(tap.onMouseOut);
	return (
		<box
			ref={(value) => {
				node = value;
				anchor?.(value);
			}}
			border={["left"]}
			borderColor={uiColors.accent}
			backgroundColor={
				hover.hovered()
					? uiColors.bgHover
					: props.keyboard && registry?.selected() === id
						? uiColors.bgSurface0
						: uiColors.bgMantle
			}
			paddingBottom={1}
			paddingLeft={2}
			paddingRight={1}
			flexShrink={0}
			{...tap}
			{...hover}
		>
			<box flexDirection="row" justifyContent="flex-end" height={1}>
				<text fg={uiColors.textMuted}>{props.expanded ? "▾ " : "▸ "}</text>
				<Stamp timestamp={props.timestamp} />
			</box>
			<box
				maxHeight={props.expanded ? props.text.length + 1 : 5}
				overflow="hidden"
			>
				<text fg={uiColors.textPrimary} wrapMode="word">
					{props.text}
				</text>
			</box>
		</box>
	);
}
