/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import type { JSX } from "solid-js";
import { SearchHeader } from "../components/SearchHeader";
import { uiColors } from "../theme/colors";

export interface DetailSectionProps {
	title?: string;
	header?: JSX.Element;
	children: JSX.Element;
	borderColor?: string;
	titleColor?: string;
	active?: boolean;
	style?: Record<string, unknown>;
}

export function DetailSection(props: DetailSectionProps) {
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={
				props.style ?? {
					width: "100%",
					flexDirection: "column",
					overflow: "hidden",
				}
			}
		>
			<SearchHeader>
				{props.header ?? (
					<text
						fg={props.titleColor ?? uiColors.textPrimary}
						attributes={TextAttributes.BOLD}
					>
						{props.title}
					</text>
				)}
			</SearchHeader>
			<box
				style={{
					width: "100%",
					flexDirection: "row",
					flexGrow: 1,
					minHeight: 0,
				}}
			>
				{/* The focused panel's left line is the same one-column marker the
				    selection rows and the agent session blocks use. */}
				<box
					border={["left"]}
					borderColor={props.active ? uiColors.primary : "transparent"}
					style={{ width: 1, height: "100%", flexShrink: 0 }}
				/>
				<box
					style={{
						flexGrow: 1,
						flexDirection: "column",
						overflow: "hidden",
						minWidth: 0,
					}}
				>
					{props.children}
				</box>
			</box>
		</box>
	);
}
