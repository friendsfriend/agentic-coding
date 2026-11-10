/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "../theme/colors";
import { GenericModal } from "./GenericModal.tsx";
import {
	activeKeybindCatalog,
	helpModalRows,
	type KeybindSection,
} from "./keybinds.ts";
import { useModalBackdrop } from "./mouse/useModalBackdrop.ts";
import { useWheelScroll } from "./mouse/useWheelScroll.ts";

/**
 * Shared `?` help modal: renders the active surface's full keybind catalog
 * (standard keys included), one section at a time with `j/k` scrolling.
 */
export function HelpModal(props: {
	title: string;
	offset: number;
	lines: number;
	/** Catalog override for tests; defaults to the active surface catalog. */
	sections?: KeybindSection[];
	/** Portal z-order when the help stacks above another modal. */
	zIndex?: number;
	/** Backdrop dismissal; defaults to dispatching this dialog's own `Esc`. */
	onBackdropClick?: () => void;
	/**
	 * Pointer: the wheel moves the offset the caller owns. The help modal is the
	 * surface built for reading a long list, so it scrolls under the pointer like
	 * the keys it advertises.
	 */
	onScrollOffset?: (offset: number) => void;
}) {
	const backdrop = useModalBackdrop({
		kind: "help",
		...(props.onBackdropClick ? { dismiss: props.onBackdropClick } : {}),
	});
	const sections = () => props.sections ?? activeKeybindCatalog();
	const rows = () => helpModalRows(sections());
	const visible = () => rows().slice(props.offset, props.offset + props.lines);
	const wheel = useWheelScroll({
		enabled: () =>
			props.onScrollOffset !== undefined && rows().length > props.lines,
		onScroll: (direction, delta) => {
			if (!props.onScrollOffset) return;
			const max = Math.max(0, rows().length - props.lines);
			const step = direction === "up" ? -delta : delta;
			props.onScrollOffset(Math.max(0, Math.min(max, props.offset + step)));
		},
	});
	return (
		<GenericModal
			{...backdrop}
			title={props.title}
			widthPercent={0.72}
			heightPercent={0.78}
			zIndex={props.zIndex}
			help={[
				{ key: "j/k", action: "Navigate" },
				{ key: "Esc", action: "Close" },
			]}
			helpSections={false}
		>
			<box {...wheel} width="100%" flexDirection="column" overflow="hidden">
				<For each={visible()}>
					{(row) =>
						"title" in row ? (
							<text
								fg={uiColors.textPrimary}
								attributes={TextAttributes.BOLD}
								flexShrink={0}
							>
								{row.title}
							</text>
						) : (
							<box flexDirection="row" paddingLeft={1} flexShrink={0}>
								<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
									{row.key.padEnd(14)}
								</text>
								<text fg={uiColors.textPrimary}>{row.action}</text>
							</box>
						)
					}
				</For>
			</box>
		</GenericModal>
	);
}
