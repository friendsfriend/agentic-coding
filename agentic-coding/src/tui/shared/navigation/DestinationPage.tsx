/** @jsxImportSource @opentui/solid */
// Home and category pages (replace-nested-tabs-with-page-navigation, task
// 2.1). Both render the same destination list: a page is a list of child
// destinations, not a tab row, and the row chrome comes from the shell's
// breadcrumb. Selection state is controlled by the caller so it can live in
// route-keyed view state and survive leaving and returning.
import {
	Card,
	hostBodyLines,
	ScrollableList,
	uiColors,
	useTerminalDimensions,
} from "@ui";
import { Show } from "solid-js";
import type { Route } from "../routes.ts";
import type { DestinationEntry } from "./destinations.ts";

export interface DestinationPageProps {
	entries: DestinationEntry[];
	selectedIndex: number;
	onSelectIndex: (index: number) => void;
	onOpen: (entry: DestinationEntry) => void;
	/** Empty-state message when the surface exposes no destination. */
	emptyMessage?: string;
}

/**
 * A destination list page. The page renders no title or description row: the
 * shell chrome names the location, and keybind hints belong to the footer and
 * the `?` help modal, never to a page body.
 */
export function DestinationPage(props: DestinationPageProps) {
	const dimensions = useTerminalDimensions();
	const itemHeight = 2;
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
			}}
		>
			<Show
				when={props.entries.length > 0}
				fallback={
					<box style={{ flexGrow: 1, justifyContent: "center" }}>
						<text fg={uiColors.textMuted}>
							{props.emptyMessage ?? "No destinations available"}
						</text>
					</box>
				}
			>
				<ScrollableList
					items={props.entries}
					selectedIndex={props.selectedIndex}
					availableLines={hostBodyLines(dimensions().height)}
					estimatedItemHeight={itemHeight}
					showScrollIndicator={false}
					renderItem={(entry, isSelected, index) => (
						<Card
							height={itemHeight}
							selected={isSelected()}
							onMouseUp={() => props.onSelectIndex(index)}
							title={entry.label}
							cells={
								entry.description
									? [<text fg={uiColors.textMuted}>{entry.description}</text>]
									: undefined
							}
						/>
					)}
				/>
			</Show>
		</box>
	);
}

export type { DestinationEntry, Route };
