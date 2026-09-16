/** @jsxImportSource @opentui/solid */
// Home and category pages (replace-nested-tabs-with-page-navigation, task
// 2.1). Both render the same destination list: a page is a list of child
// destinations, not a tab row, and the row chrome comes from the shell's
// breadcrumb. Selection state is controlled by the caller so it can live in
// route-keyed view state and survive leaving and returning.
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Show } from "solid-js";
import { uiColors } from "../colors";
import type { Route } from "../routes";
import { SelectableList } from "../Selectable";
import type { DestinationEntry } from "./destinations";

export interface DestinationPageProps {
	title: string;
	/** Optional one-line description under the title. */
	description?: string;
	entries: DestinationEntry[];
	selectedIndex: number;
	onSelectIndex: (index: number) => void;
	onOpen: (entry: DestinationEntry) => void;
	/** Empty-state message when the surface exposes no destination. */
	emptyMessage?: string;
}

export function DestinationPage(props: DestinationPageProps) {
	const dimensions = useTerminalDimensions();
	const itemHeight = () => (dimensions().width < 80 ? 2 : 2);
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<box style={{ flexDirection: "column", flexShrink: 0, height: 1 }}>
				<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
					{props.title}
				</text>
			</box>
			<Show when={props.description}>
				<box style={{ flexDirection: "column", flexShrink: 0, height: 1 }}>
					<text fg={uiColors.textMuted}>{props.description}</text>
				</box>
			</Show>
			<box style={{ height: 1, flexShrink: 0 }} />
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
				<SelectableList
					items={props.entries}
					selectedIndex={props.selectedIndex}
					onSelect={props.onSelectIndex}
					itemHeight={itemHeight()}
					focusable={false}
					renderItem={(entry, selected) => (
						<box
							style={{
								flexDirection: "column",
								paddingLeft: 2,
								paddingRight: 2,
							}}
						>
							<text
								fg={selected ? uiColors.primary : uiColors.textPrimary}
								attributes={selected ? TextAttributes.BOLD : undefined}
							>
								{entry.label}
							</text>
							<Show when={entry.description}>
								<text fg={uiColors.textMuted}>{entry.description}</text>
							</Show>
						</box>
					)}
				/>
			</Show>
		</box>
	);
}

/** Home: the four destinations (Environments, Observability, Wiki, bridge). */
export function HomePage(
	props: Omit<DestinationPageProps, "title" | "description">,
) {
	return (
		<DestinationPage
			{...props}
			title="Home"
			description="Choose a destination. Ctrl+P jumps anywhere."
		/>
	);
}

/** Category page: the child destinations of a feature. */
export function CategoryPage(
	props: Omit<DestinationPageProps, "description"> & { description?: string },
) {
	return <DestinationPage {...props} />;
}

export type { DestinationEntry, Route };
