/** @jsxImportSource @opentui/solid */
import { HelpText } from "../../shared/HelpText";
import {
	activeKeybindCatalog,
	activeKeybindContext,
	footerKeybinds,
	type Keybind,
} from "../../shared/keybinds";
import { uiColors } from "../ui/colors";

export type { Keybind };

/** Fallback right-anchored entry so `?` help is advertised on every surface. */
const FALLBACK_HELP: Keybind = { key: "?", action: "help" };

/**
 * Shell footer. Reads the active keybind catalog published by whichever
 * surface owns the current footer (shell tab, workspace overview, or
 * dashboard panel). It stays exactly one row high: the special keybinds fill
 * a left column that clips overflow, while `?` help is pinned to the right so
 * it remains visible no matter how many keys precede it.
 */
export function StatusBar(props: {
	prompt?: string;
	keybinds?: readonly Keybind[];
}) {
	const keybinds = () =>
		props.keybinds
			? [...props.keybinds]
			: footerKeybinds(activeKeybindCatalog(), activeKeybindContext());
	const help = () =>
		keybinds().find((keybind) => keybind.key === "?") ?? FALLBACK_HELP;
	const entries = () => keybinds().filter((keybind) => keybind.key !== "?");
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: 1,
				flexDirection: "row",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<box
				style={{
					flexGrow: 1,
					flexShrink: 1,
					minWidth: 0,
					overflow: "hidden",
					flexDirection: "row",
				}}
			>
				{props.prompt ? (
					<text fg={uiColors.textMuted}>{props.prompt}</text>
				) : null}
				<HelpText entries={entries()} />
			</box>
			<box style={{ flexShrink: 0, marginLeft: 1 }}>
				<HelpText entries={[help()]} />
			</box>
		</box>
	);
}
