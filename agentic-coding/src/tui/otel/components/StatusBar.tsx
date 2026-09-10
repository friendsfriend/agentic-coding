/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions } from "@opentui/solid";
import { For } from "solid-js";
import { HelpText, wrapHelpEntries } from "../../shared/HelpText";
import {
	activeKeybindCatalog,
	activeKeybindContext,
	footerKeybinds,
	type Keybind,
} from "../../shared/keybinds";
import { uiColors } from "../ui/colors";

export type { Keybind };

/**
 * Shell footer. Reads the active keybind catalog published by whichever
 * surface owns the current footer (shell tab, workspace overview, or
 * dashboard panel) and renders only its special keys, wrapped to the terminal
 * width so long catalogs are not clipped.
 */
export function StatusBar(props: {
	prompt?: string;
	keybinds?: readonly Keybind[];
	/** Horizontal inset already applied by the parent box (padding). */
	inset?: number;
}) {
	const dimensions = useTerminalDimensions();
	const keybinds = () =>
		props.keybinds
			? [...props.keybinds]
			: footerKeybinds(activeKeybindCatalog(), activeKeybindContext());
	// Leave room for this bar's padding, the parent's inset, and the prompt.
	const maxWidth = () =>
		Math.max(
			1,
			dimensions().width - 2 - (props.inset ?? 0) - (props.prompt?.length ?? 0),
		);
	const lines = () => wrapHelpEntries(keybinds(), maxWidth());
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: Math.max(1, lines().length),
				flexDirection: "column",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<For each={lines()}>
				{(line, index) => (
					<box style={{ flexDirection: "row" }}>
						{index() === 0 ? (
							<text fg={uiColors.textMuted}>{props.prompt ?? ""}</text>
						) : null}
						<HelpText entries={line} />
					</box>
				)}
			</For>
		</box>
	);
}
