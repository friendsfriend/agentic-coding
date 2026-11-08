/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { Selectable } from "./Selectable.tsx";

export type WorkspaceTaskObservation = {
	status: string | null;
	outcome: string | null;
	attention: boolean;
	repository: string;
};
/** Original three-line workspace row presentation, with native task observations
 * instead of workflow overviews. Position is display only, never an identity. */
export function WorkspaceTaskRow(props: {
	name: string;
	meta: string;
	task: WorkspaceTaskObservation;
	position: number;
	expanded: boolean;
	selected: boolean;
	gesture: RowGestureState;
	open: () => void;
}) {
	const clip = (text: string, width: number) => {
		const characters = Array.from(text);
		return characters.length > width
			? `${characters.slice(0, Math.max(0, width - 1)).join("")}…`
			: text;
	};
	const status = () => {
		const task = props.task;
		if (task.attention) return { glyph: "!", color: uiColors.warning };
		if (task.status === null) return { glyph: "?", color: uiColors.textMuted };
		if (task.status !== "terminal") return { glyph: "…", color: uiColors.info };
		if (task.outcome === "completed")
			return { glyph: "✓", color: uiColors.success };
		if (task.outcome === "failed") return { glyph: "!", color: uiColors.error };
		return { glyph: "·", color: uiColors.textMuted };
	};
	const repository = () =>
		props.task.repository.split(/[\\/]/).filter(Boolean).at(-1) ??
		props.task.repository;
	return (
		<Selectable
			height={3}
			selected={props.selected}
			gesture={props.gesture}
			onMouseUp={props.open}
		>
			<Show
				when={props.expanded}
				fallback={
					<box height={3} minWidth={0} flexDirection="column" overflow="hidden">
						<text
							fg={
								props.task.attention
									? uiColors.warning
									: props.selected
										? uiColors.textPrimary
										: uiColors.textSecondary
							}
						>
							<strong>{clip(String(props.position + 1), 4)}</strong>
						</text>
						<text fg={status().color}>{status().glyph}</text>
						<text fg={uiColors.textMuted}>
							{Array.from(props.meta.trim())[0] ?? "·"}
						</text>
					</box>
				}
			>
				<box height={3} minWidth={0} flexDirection="column" overflow="hidden">
					<box height={1} minWidth={0} flexDirection="row" overflow="hidden">
						<text fg={status().color}>
							<strong>{status().glyph}</strong>
						</text>
						<text
							fg={
								props.selected ? uiColors.textPrimary : uiColors.textSecondary
							}
						>
							<strong>{` ${clip(props.name, 27)}`}</strong>
						</text>
					</box>
					<text
						fg={props.task.attention ? uiColors.warning : uiColors.textMuted}
						wrapMode="none"
						truncate
					>
						{clip(props.meta, 29)}
					</text>
					<text fg={uiColors.textMuted} wrapMode="none" truncate>
						{clip(repository(), 29)}
					</text>
				</box>
			</Show>
		</Selectable>
	);
}
