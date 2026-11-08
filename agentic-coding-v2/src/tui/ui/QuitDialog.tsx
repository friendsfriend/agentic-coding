/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { onCleanup } from "solid-js";
import { HelpText } from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { SearchHeader } from "../presentation/components/SearchHeader.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";

/** Original warning confirmation chrome for local terminal exit only.
 * No native review/approval/cancellation state is passed to this dialog. */
export function QuitDialog(props: {
	active: boolean;
	resolve: (exit: boolean) => void;
}) {
	const dimensions = useTerminalDimensions();
	let disposed = false;
	const enabled = () => !disposed && props.active;
	const resolve = (exit: boolean) => {
		if (enabled())
			queueMicrotask(() => {
				if (enabled()) props.resolve(exit);
			});
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.quitConfirmation",
		priority: 190,
		enabled,
		bindings: [
			{ key: "y", cmd: () => resolve(true) },
			{ key: "n", cmd: () => resolve(false) },
			{ key: "escape", cmd: () => resolve(false) },
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
	});
	return (
		<ReadOnlyModalFrame
			width={Math.max(1, Math.floor(dimensions().width * 0.4))}
			height={Math.max(1, Math.min(11, dimensions().height))}
			active={enabled()}
			close={() => resolve(false)}
			footerHeight={1}
			header={
				<SearchHeader>
					<text fg={uiColors.warning} attributes={TextAttributes.BOLD}>
						⚠ Quit terminal client?
					</text>
				</SearchHeader>
			}
			footer={
				<HelpText
					entries={[
						{ key: "y", action: "Quit client" },
						{ key: "n", action: "Stay" },
						{ key: "Esc", action: "Stay" },
					]}
					activatable={() => true}
					onActivate={(entry) => resolve(entry.key === "y")}
				/>
			}
		>
			<box
				width="100%"
				flexGrow={1}
				flexDirection="column"
				paddingTop={1}
				justifyContent="center"
				alignItems="center"
			>
				<text fg={uiColors.textPrimary} wrapMode="word">
					{
						"Unsaved local drafts/UI history are lost.\nNo abort or approval is requested.\nCLI may close its host; native outcome remains unknown."
					}
				</text>
			</box>
		</ReadOnlyModalFrame>
	);
}
