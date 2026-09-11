/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { type JSX, onCleanup } from "solid-js";
import { HelpText } from "../../shared/HelpText";
import type { Keybind, KeybindSection } from "../../shared/keybinds";
import { ModalHelpOverlay } from "../../shared/ModalHelpOverlay";
import {
	type ModalHelpRegistration,
	registerModalHelp,
	withModalHelpKeybind,
} from "../../shared/modalHelp";
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
	/** Catalog the modal's own `?` help shows; `false` disables it. */
	helpSections?: KeybindSection[] | false;
}) {
	const dimensions = useTerminalDimensions();
	const width = () =>
		Math.floor(dimensions().width * (props.widthPercent ?? 0.5));
	const height = () =>
		Math.floor(dimensions().height * (props.heightPercent ?? 0.7));
	// Same `? help` contract as the shared portaled modal: advertise the entry
	// and open the shared HelpModal over this dialog.
	const modalHelpEnabled = (): boolean =>
		props.helpSections !== false &&
		(props.helpSections !== undefined || props.help.length > 0);
	const modalHelpEntries = (): readonly Keybind[] =>
		modalHelpEnabled() ? withModalHelpKeybind(props.help) : props.help;
	const modalHelpSections = (): KeybindSection[] => {
		if (!modalHelpEnabled()) return [];
		if (props.helpSections) return props.helpSections;
		return [{ title: "Actions", keybinds: [...modalHelpEntries()] }];
	};
	const overlayHelpLines = (): number =>
		Math.max(5, Math.floor(dimensions().height * 0.78) - 5);
	const helpRegistration: ModalHelpRegistration = {
		sections: modalHelpSections,
		lines: overlayHelpLines,
	};
	if (props.helpSections !== false)
		onCleanup(registerModalHelp(helpRegistration));
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
				<HelpText entries={modalHelpEntries()} />
			</box>
			<ModalHelpOverlay zIndex={1} />
		</box>
	);
}
