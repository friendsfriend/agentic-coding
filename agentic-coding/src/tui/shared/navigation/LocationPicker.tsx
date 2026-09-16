/** @jsxImportSource @opentui/solid */
// Shared location picker (replace-nested-tabs-with-page-navigation, task 2.1).
// It reuses the existing modal framing, selection list and search header rather
// than introducing a second overlay style: a bounded, searchable list of known
// destinations that jumps straight to a page.
import { createMemo, For, Show } from "solid-js";
import { uiColors } from "../colors";
import { GenericModal } from "../GenericModal";
import type { Route } from "../routes";
import { Selectable } from "../Selectable";
import { type DestinationEntry, filterPickerEntries } from "./destinations";
import { locationPickerKeybindCatalog } from "./keybinds";

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
			helpSections={locationPickerKeybindCatalog()}
			widthPercent={0.6}
			heightPercent={0.6}
			searchQuery={props.query}
			searchResultCount={matches().length}
			onBackdropClick={props.onClose}
			stopDialogClick
			customFooter={
				<text fg={uiColors.textMuted}>Enter opens · Esc closes</text>
			}
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
					<For each={matches()}>
						{(entry, index) => {
							const selected = () => index() === props.selectedIndex;
							return (
								<Selectable
									selected={selected()}
									onMouseUp={() => {
										props.onSelectIndex(index());
										props.onAccept(entry.route);
									}}
								>
									<box
										style={{
											flexDirection: "column",
											paddingLeft: 2,
											paddingRight: 2,
										}}
									>
										<text
											fg={selected() ? uiColors.primary : uiColors.textPrimary}
										>
											{entry.label}
										</text>
										<Show when={entry.description}>
											<text fg={uiColors.textMuted}>
												{entry.group} · {entry.description}
											</text>
										</Show>
									</box>
								</Selectable>
							);
						}}
					</For>
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
