/** @jsxImportSource @opentui/solid */
import { type JSX, Show } from "solid-js";
import { uiColors } from "./colors";
import {
	GenericModal,
	type HelpEntry,
	type SummaryEntry,
} from "./GenericModal";
import { SelectableList } from "./Selectable";

export function ListViewModal<T>(props: {
	title: string;
	fieldLabel?: string;
	items: T[];
	selectedIndex: number;
	renderItem: (item: T, selected: boolean) => JSX.Element;
	help: HelpEntry[];
	summary?: SummaryEntry[];
	step?: number;
	total?: number;
	filterQuery?: string;
	filterActive?: boolean;
	heightPercent?: number;
	itemHeight?: number;
}) {
	return (
		<GenericModal
			title={props.title}
			fieldLabel={props.fieldLabel}
			step={props.step}
			total={props.total}
			summary={props.summary}
			search={props.filterActive ? (props.filterQuery ?? "") : undefined}
			help={props.help}
			heightPercent={props.heightPercent ?? 0.6}
		>
			<Show
				when={props.items.length}
				fallback={<text fg={uiColors.textMuted}>No matching values</text>}
			>
				<box
					width="100%"
					height="100%"
					flexGrow={1}
					flexShrink={1}
					minHeight={0}
					flexDirection="column"
				>
					<SelectableList
						items={props.items}
						itemHeight={props.itemHeight}
						selectedIndex={props.selectedIndex}
						renderItem={(item, selected) => (
							<box
								width="100%"
								height={props.itemHeight ?? 1}
								flexShrink={0}
								overflow="hidden"
							>
								{props.renderItem(item, selected)}
							</box>
						)}
					/>
				</box>
			</Show>
		</GenericModal>
	);
}
