/** @jsxImportSource @opentui/solid */
// One bounded breadcrumb row (replace-nested-tabs-with-page-navigation, task
// 2.1). Segments come from the structural ancestor chain (never history); the
// row stays exactly one line high and collapses middle ancestors on narrow
// terminals while keeping the current location and the focused ancestor
// readable.
import { TextAttributes } from "@opentui/core";
import { uiColors, useTerminalDimensions } from "@ui";
import { For, Show } from "solid-js";
import type { Route } from "../routes.ts";
import { BREADCRUMB_SEPARATOR, breadcrumbSegments } from "./breadcrumbs.ts";

export interface BreadcrumbRowProps {
	/** Structural ancestors, root first, current location last. */
	ancestors: Route[];
	/** Keyboard cursor over the logical ancestor chain. */
	focusedIndex: number;
	onSelectIndex?: (index: number) => void;
	onNavigate?: (route: Route) => void;
	/** Row width override for tests; defaults to the terminal width. */
	width?: number;
}

export function BreadcrumbRow(props: BreadcrumbRowProps) {
	const dimensions = useTerminalDimensions();
	const width = () => props.width ?? Math.max(0, dimensions().width - 2);
	const segments = () =>
		breadcrumbSegments(props.ancestors, width(), props.focusedIndex);
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: 1,
				flexShrink: 0,
				flexDirection: "row",
				paddingLeft: 1,
				paddingRight: 1,
				overflow: "hidden",
			}}
		>
			<For each={segments()}>
				{(segment, index) => (
					<>
						<Show when={index() > 0}>
							<text fg={uiColors.textMuted}>{BREADCRUMB_SEPARATOR}</text>
						</Show>
						<box
							onMouseUp={() => {
								const route = segment.route;
								if (!route) {
									// Collapsed placeholder: reveal its first ancestor and let
									// the keyboard cursor walk the hidden range.
									props.onSelectIndex?.(segment.collapsedRange?.start ?? 0);
									return;
								}
								const target = props.ancestors.indexOf(route);
								if (target >= 0) props.onSelectIndex?.(target);
								props.onNavigate?.(route);
							}}
							style={{ flexShrink: 0 }}
						>
							<text
								fg={
									segment.focused
										? uiColors.primary
										: segment.route
											? uiColors.textSecondary
											: uiColors.textMuted
								}
								attributes={segment.focused ? TextAttributes.BOLD : undefined}
							>
								{segment.label}
							</text>
						</box>
					</>
				)}
			</For>
		</box>
	);
}
