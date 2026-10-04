/** @jsxImportSource @opentui/solid */
// Bordered-less panel: a title row with an accent block, then the body. The
// dashboard stacks several of these and highlights the focused one; the env
// surface uses the same chrome for its sections.
import { TextAttributes } from "@opentui/core";
import type { JSX } from "solid-js";
import { uiColors } from "../theme/colors";

export interface PanelProps {
	title: string;
	children: JSX.Element;
	/** Focused panel: title and accent block take this colour. */
	accent?: string;
	active?: boolean;
	style?: Record<string, unknown>;
	/** Optional element right-aligned in the title row (a control glyph); the
	 * caller owns its behaviour and colour. */
	accessory?: JSX.Element;
}

export function Panel(props: PanelProps) {
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{ flexDirection: "column", overflow: "hidden", ...props.style }}
		>
			<box
				style={{
					height: 1,
					paddingLeft: 1,
					paddingRight: 1,
					flexShrink: 0,
					flexDirection: "row",
				}}
			>
				<text
					fg={
						props.active
							? (props.accent ?? uiColors.primary)
							: uiColors.textPrimary
					}
					attributes={TextAttributes.BOLD}
				>
					{props.title}
				</text>
				<box style={{ flexGrow: 1 }} />
				{props.accessory}
			</box>
			<box style={{ flexGrow: 1, minHeight: 0, flexDirection: "row" }}>
				{/* The focused panel's left line is the same one-column marker the
				    selection rows and the agent session blocks use. */}
				<box
					border={["left"]}
					borderColor={
						props.active ? (props.accent ?? uiColors.primary) : "transparent"
					}
					style={{ width: 1, height: "100%", flexShrink: 0 }}
				/>
				<box
					style={{
						flexGrow: 1,
						minWidth: 0,
						flexDirection: "column",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					{props.children}
				</box>
			</box>
		</box>
	);
}
