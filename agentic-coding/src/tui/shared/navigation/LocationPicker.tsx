/** @jsxImportSource @opentui/solid */
// Shared location picker (replace-nested-tabs-with-page-navigation, task 2.1).
// It reuses the existing modal framing, selection list and search header rather
// than introducing a second overlay style: a bounded, searchable list of known
// destinations that jumps straight to a page.

import { Card, GenericModal, ScrollableList, uiColors } from "@ui";
import { createMemo, Show } from "solid-js";
import type { Route } from "../routes.ts";
import { type DestinationEntry, filterPickerEntries } from "./destinations.ts";
import {
	locationPickerFooterKeybinds,
	locationPickerKeybindCatalog,
} from "./keybinds.ts";

export interface LocationPickerProps {
	entries: DestinationEntry[];
	query: string;
	selectedIndex: number;
	onQueryChange: (query: string) => void;
	onSelectIndex: (index: number) => void;
	onAccept: (route: Route) => void;
	onClose: () => void;
}

export function LocationPicker(props: LocationPickerProps) {
	const matches = createMemo(() =>
		filterPickerEntries(props.entries, props.query),
	);
	return (
		<GenericModal
			title="Locations"
			help={locationPickerFooterKeybinds()}
			helpSections={locationPickerKeybindCatalog()}
			widthPercent={0.6}
			heightPercent={0.6}
			searchQuery={props.query}
			searchResultCount={matches().length}
			onBackdropClick={props.onClose}
			stopDialogClick
		>
			<box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
				<Show
					when={matches().length > 0}
					fallback={
						<box style={{ paddingLeft: 2 }}>
							<text fg={uiColors.textMuted}>No matching location</text>
						</box>
					}
				>
					<ScrollableList
						items={matches()}
						selectedIndex={props.selectedIndex}
						estimatedItemHeight={2}
						showScrollIndicator={false}
						renderItem={(entry, isSelected, index) => (
							<Card
								height={2}
								selected={isSelected()}
								title={entry.label}
								onMouseUp={() => {
									props.onSelectIndex(index);
									if (entry.route) props.onAccept(entry.route);
								}}
								cells={
									entry.description
										? [
												<text fg={uiColors.textMuted}>
													{entry.group} · {entry.description}
												</text>,
											]
										: undefined
								}
							/>
						)}
					/>
				</Show>
			</box>
		</GenericModal>
	);
}

/** The location the picker would open for the current query/selection. */
export function pickerSelection(
	entries: DestinationEntry[],
	query: string,
	selectedIndex: number,
): DestinationEntry | undefined {
	return filterPickerEntries(entries, query)[selectedIndex];
}
