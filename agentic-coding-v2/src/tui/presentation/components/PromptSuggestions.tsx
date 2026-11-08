/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import { useRowMouse } from "./mouse/useRowMouse.ts";

export type PromptSuggestion = {
	name: string;
	description: string;
	/** Prepared native text, including any explicit target/placeholders. */
	text: string;
};

/** Original above-prompt autocomplete composition. Selection and completion are
 * callbacks only: this component cannot submit, approve or dispatch commands. */
export function PromptSuggestions(props: {
	items: readonly PromptSuggestion[];
	selection: number;
	select: (index: number) => void;
	choose: (item: PromptSuggestion) => void;
}) {
	const visible = createMemo(() => {
		if (props.items.length <= 8) return { items: props.items, offset: 0 };
		const offset = Math.min(
			Math.max(0, props.selection - 4),
			props.items.length - 8,
		);
		return { items: props.items.slice(offset, offset + 8), offset };
	});
	return (
		<box
			flexDirection="column"
			flexShrink={0}
			border={["left"]}
			borderColor={uiColors.accent}
			backgroundColor={uiColors.bgMantle}
		>
			<For each={visible().items}>
				{(command, index) => (
					<box
						flexDirection="row"
						gap={2}
						paddingLeft={2}
						paddingRight={1}
						backgroundColor={
							visible().offset + index() === props.selection
								? uiColors.selectionBg
								: undefined
						}
						{...useRowMouse({
							index: () => visible().offset + index(),
							selectedIndex: () => props.selection,
							activatable: () => true,
							onSelect: (row) =>
								props.select(
									Math.max(0, Math.min(row, props.items.length - 1)),
								),
							onActivate: () => props.choose(command),
						})}
					>
						<text
							width={14}
							flexShrink={0}
							fg={
								visible().offset + index() === props.selection
									? uiColors.selectionText
									: uiColors.textPrimary
							}
						>
							{command.name}
						</text>
						<text
							fg={
								visible().offset + index() === props.selection
									? uiColors.selectionText
									: uiColors.textMuted
							}
						>
							{command.description}
						</text>
					</box>
				)}
			</For>
			<Show when={props.items.length > visible().items.length}>
				<text
					paddingLeft={2}
					fg={uiColors.textMuted}
				>{`… +${props.items.length - visible().items.length} more`}</text>
			</Show>
		</box>
	);
}
