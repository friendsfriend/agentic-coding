/** @jsxImportSource @opentui/solid */
// The original destination/settings list: one Card per entry (title row plus a
// muted detail row), windowed so the selected card stays visible. Selection is
// owned by the caller; a tap selects, a tap on the selected card opens it.
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { Card } from "./Card.tsx";

export type CardEntry = {
	id: string;
	title: string;
	detail?: string;
	/** Right-aligned value column on the detail row. */
	value?: string;
	accent?: string;
	tone?: "warning" | "muted";
};

export function CardList(props: {
	entries: readonly CardEntry[];
	selectedIndex: number;
	availableLines: number;
	onSelect: (index: number) => void;
	onActivate: (index: number) => void;
	empty?: JSX.Element;
}) {
	const height = 2;
	const capacity = () =>
		Math.max(1, Math.floor(Math.max(height, props.availableLines) / height));
	const start = () =>
		Math.max(
			0,
			Math.min(
				props.selectedIndex - Math.floor(capacity() / 2),
				props.entries.length - capacity(),
			),
		);
	const visible = () =>
		props.entries
			.slice(start(), start() + capacity())
			.map((entry, offset) => ({ entry, index: start() + offset }));
	return (
		<Show
			when={props.entries.length > 0}
			fallback={
				props.empty ?? <text fg={uiColors.textMuted}>Nothing here yet.</text>
			}
		>
			<box flexDirection="column" width="100%" flexShrink={0}>
				<For each={visible()}>
					{(row) => (
						<Card
							height={height}
							selected={() => row.index === props.selectedIndex}
							title={row.entry.title}
							{...(row.entry.accent ? { accent: row.entry.accent } : {})}
							onMouseUp={() => props.onSelect(row.index)}
							onActivate={() => props.onActivate(row.index)}
							cells={
								row.entry.detail !== undefined || row.entry.value !== undefined
									? [
											<text
												fg={
													row.entry.tone === "warning"
														? uiColors.warning
														: uiColors.textMuted
												}
											>
												{row.entry.detail ?? ""}
											</text>,
											...(row.entry.value !== undefined
												? [
														<text fg={uiColors.textSecondary}>
															{row.entry.value}
														</text>,
													]
												: []),
										]
									: undefined
							}
							columns={row.entry.value !== undefined ? 2 : 1}
						/>
					)}
				</For>
				<Show when={props.entries.length > capacity()}>
					<text fg={uiColors.textMuted}>
						{`${props.selectedIndex + 1}/${props.entries.length}`}
					</text>
				</Show>
			</box>
		</Show>
	);
}
