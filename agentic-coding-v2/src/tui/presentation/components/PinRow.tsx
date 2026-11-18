/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import type { RowGestureState } from "./mouse/useRowMouse.ts";
import { useTap } from "./mouse/useTap.ts";
import { Selectable } from "./Selectable.tsx";
import type { WorkspaceEntry } from "./WorkspaceNavigation.tsx";

export function PinRow(props: {
	pin: { glyph: string; label: string; meta: string };
	selected: boolean;
	height: number;
	wide?: boolean;
	width?: number;
	tone?: WorkspaceEntry["tone"];
	tree?: WorkspaceEntry["tree"];
	onToggleBranch?: () => void;
	onActivate: () => void;
	gesture?: RowGestureState;
}) {
	const clip = (value: string, room = props.width ?? 30) => {
		const points = Array.from(value);
		return points.length > room
			? `${points.slice(0, Math.max(0, room - 1)).join("")}…`
			: value;
	};
	const tone = () =>
		props.tone === "muted"
			? uiColors.textMuted
			: props.tone
				? uiColors[props.tone]
				: uiColors.textSecondary;
	const labelTone = () =>
		props.tone === "error" || props.tone === "warning"
			? tone()
			: props.tree?.kind === "project"
				? uiColors.primary
				: props.tree?.kind === "workflow"
					? uiColors.accent
					: props.selected
						? uiColors.textPrimary
						: props.tone
							? tone()
							: uiColors.textPrimary;
	const disclosure = useTap(() => props.onToggleBranch?.(), {
		enabled: () => props.tree?.branch === true,
		stopPropagation: true,
	});
	return (
		<Selectable
			gesture={props.gesture}
			height={props.height}
			selected={props.selected}
			hoverBackground={uiColors.bgHover}
			selectedBackground={uiColors.bgSurface1}
			onMouseUp={props.onActivate}
		>
			<Show
				when={props.wide ?? props.height > 1}
				fallback={<text fg={tone()}>{props.pin.glyph}</text>}
			>
				<box flexDirection="row" height={1} flexShrink={0}>
					<Show when={props.tree}>
						<text fg={uiColors.textMuted}>{props.tree?.prefix}</text>
						<text fg={uiColors.textMuted} {...disclosure}>
							{props.tree?.branch ? (props.tree.collapsed ? "▸ " : "▾ ") : "  "}
						</text>
					</Show>
					<text fg={tone()}>{props.pin.glyph} </text>
					<text fg={labelTone()}>
						<strong>
							{clip(
								props.pin.label,
								Math.max(
									4,
									(props.width ?? 30) - (props.tree?.prefix.length ?? 0) - 5,
								),
							)}
						</strong>
					</text>
				</box>
				<Show when={props.height > 1}>
					<box flexDirection="row" height={1} flexShrink={0}>
						<Show when={props.tree}>
							<text fg={uiColors.textMuted}>
								{props.tree?.continuation}
								{"  "}
							</text>
						</Show>
						<text
							fg={
								props.tree?.summary
									? tone()
									: props.tree?.kind === "workflow"
										? uiColors.info
										: uiColors.textMuted
							}
						>
							{clip(
								props.tree?.summary || props.pin.meta,
								Math.max(
									4,
									(props.width ?? 30) -
										(props.tree ? props.tree.continuation.length + 2 : 0),
								),
							)}
						</text>
					</box>
				</Show>
			</Show>
		</Selectable>
	);
}
