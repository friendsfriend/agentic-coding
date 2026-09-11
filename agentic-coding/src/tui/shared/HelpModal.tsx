/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { activeKeybindCatalog, type KeybindSection } from "./keybinds";

export type HelpSection = KeybindSection;

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
}) {
	const sections = () => props.sections ?? activeKeybindCatalog();
	const rows = () =>
		sections().flatMap((section) => [
			{ title: section.title },
			...section.keybinds,
		]);
	const visible = () => rows().slice(props.offset, props.offset + props.lines);
	return (
		<GenericModal
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
			<box width="100%" flexDirection="column" overflow="hidden">
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
