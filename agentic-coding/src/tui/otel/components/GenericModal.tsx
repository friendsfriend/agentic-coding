/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "solid-js";
import { HelpText } from "../../shared/HelpText";
import type { Keybind } from "../../shared/keybinds";
import { uiColors } from "../ui/colors";
import { FilterStatusBar } from "./FilterStatusBar";
import { SearchHeader } from "./SearchHeader";

export type HelpEntry = Keybind;

export function GenericModal(props: {
	title: string;
	children: JSX.Element;
	help: readonly Keybind[];
	widthPercent?: number;
	heightPercent?: number;
	filterSummary?: string;
	sortSummary?: string;
	search?: string;
}) {
	const dimensions = useTerminalDimensions();
	const width = () =>
		Math.floor(dimensions().width * (props.widthPercent ?? 0.5));
	const height = () =>
		Math.floor(dimensions().height * (props.heightPercent ?? 0.7));
	return (
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
		>
			<box
				backgroundColor={uiColors.bgMantle}
				width={width()}
				height={height()}
				flexDirection="column"
				paddingTop={1}
				paddingBottom={1}
				paddingLeft={2}
				paddingRight={2}
			>
				<SearchHeader
					searchMode={() => props.search !== undefined}
					searchQuery={() => props.search ?? ""}
				>
					<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
						{props.title}
					</text>
				</SearchHeader>
				<FilterStatusBar
					filterSummary={props.filterSummary}
					sortSummary={props.sortSummary}
				/>
				<box
					style={{
						width: "100%",
						flexDirection: "column",
						flexGrow: 1,
						flexShrink: 1,
						minHeight: 0,
						overflow: "hidden",
					}}
				>
					{props.children}
				</box>
				<HelpText entries={props.help} />
			</box>
		</box>
	);
}
