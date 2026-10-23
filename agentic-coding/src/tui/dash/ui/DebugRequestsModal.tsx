/** @jsxImportSource @opentui/solid */
/** Delegated debug requests dialog (add-debug-subagent-requests): what this
 * workflow asked the debug role to investigate, what came back, and which
 * evidence was filed under each request.
 *
 * Props-in and read-only on purpose: it lists, scrolls and opens the report
 * file with the platform's opener, and offers no approval, retry, cancel or any
 * other mutating action. The dashboard owns the selection and the key handling
 * (`handlers/keys.ts` → the pure `debugRequestsKeyAction`), so this dialog
 * renders exactly what it is given.
 *
 * Both panes take their line budget from the enclosing dialog
 * (`useModalContentLines`), so the window a key scrolls and the window the body
 * paints are always the same number: a fixed budget would leave the tail of a
 * long report unreachable on a short terminal and blank rows on a tall one. */
import { TextAttributes } from "@opentui/core";
import {
	GenericModal,
	type RowGestureState,
	uiColors,
	useHover,
	useKeyDispatch,
	useModalBackdrop,
	useModalContentLines,
	useRowMouse,
	useWheelScroll,
	wheelSelectsRow,
} from "@ui";
import { createMemo, For, Show } from "solid-js";
import type { DebugRequestView } from "../../../contracts/environment.ts";
import {
	type DebugRequestsReadState,
	debugRequestDetailLines,
	debugRequestListWindow,
	debugRequestRowLabel,
	debugRequestWindow,
} from "../debug-requests-panel.ts";

/** The dialog's own key help: navigation, scrolling and opening a file, never a
 * mutating action. Exported so the read-only guarantee is asserted against the
 * surface the dialog actually renders. */
export const DEBUG_REQUESTS_HELP = [
	{ key: "j/k", action: "Request" },
	{ key: "J/K", action: "Scroll report" },
	{ key: "Enter", action: "Open report file" },
	{ key: "Esc", action: "Close" },
] as const;

export interface DebugRequestsModalProps {
	readonly requests: readonly DebugRequestView[];
	readonly state: DebugRequestsReadState;
	readonly error?: string;
	readonly selectedIndex: number;
	/** How far the detail pane is scrolled, in lines. */
	readonly offset: number;
	/** Pointer: a tap selects a request (the keyboard's `j`/`k`). */
	readonly onSelectIndex?: (index: number) => void;
	/** Pointer: the wheel scrolls the report pane (the keyboard's `J`/`K`). */
	readonly onOffsetChange?: (offset: number) => void;
}

/** The list/detail body height before the dialog reports its own geometry (the
 * context is only published once the modal has laid out). */
const FALLBACK_CONTENT_LINES = 12;

export function DebugRequestsModal(props: DebugRequestsModalProps) {
	/** One holder per list: a row the store replaced still completes its press. */
	const gesture: RowGestureState = {};
	const dispatch = useKeyDispatch();
	const backdrop = useModalBackdrop({ kind: "debug-requests" });
	const contentLines = useModalContentLines();
	const lines = () => Math.max(1, contentLines?.() ?? FALLBACK_CONTENT_LINES);
	const selected = createMemo(() => props.requests[props.selectedIndex]);
	const detailLines = createMemo(() => {
		const request = selected();
		return request ? debugRequestDetailLines(request) : [];
	});
	const window = createMemo(() =>
		debugRequestWindow(detailLines(), props.offset, lines()),
	);
	const listRows = createMemo(() =>
		debugRequestListWindow(props.requests, props.selectedIndex, lines()),
	);
	// The wheel scrolls the pane the pointer is over: the report here, the list
	// beside it, and neither one changes focus (design D7).
	const reportWheel = useWheelScroll({
		enabled: () => props.onOffsetChange !== undefined,
		onScroll: (direction, delta) => {
			if (!props.onOffsetChange) return;
			const maxOffset = Math.max(0, detailLines().length - lines());
			const step = direction === "up" ? -delta : delta;
			props.onOffsetChange(
				Math.max(0, Math.min(maxOffset, props.offset + step)),
			);
		},
	});
	const listWheel = wheelSelectsRow({
		selectedIndex: () => props.selectedIndex,
		count: () => props.requests.length,
		onSelect: (index) => props.onSelectIndex?.(index),
	});
	const bodyMessage = () => {
		if (props.state === "error")
			return props.error
				? `Debug requests could not be read: ${props.error}`
				: "Debug requests could not be read";
		if (props.state === "loading") return "Loading debug requests…";
		return "This workflow has not delegated any debug request.";
	};
	const title = () =>
		props.requests.length
			? `Debug requests · ${props.requests.length}`
			: "Debug requests";
	return (
		<GenericModal
			{...backdrop}
			title={title()}
			widthPercent={0.84}
			heightPercent={0.82}
			help={[...DEBUG_REQUESTS_HELP]}
		>
			<box
				style={{
					width: "100%",
					height: "100%",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{/* A failed read is always visible, even when an earlier read left a
				    list on screen: a stale list must not read as a live one. */}
				<Show when={props.state === "error" && props.requests.length > 0}>
					<box width="100%" height={1} flexShrink={0} overflow="hidden">
						<text fg={uiColors.error} wrapMode="none" truncate>
							{bodyMessage()}
						</text>
					</box>
				</Show>
				<Show
					when={props.requests.length > 0}
					fallback={
						<text
							fg={
								props.state === "error"
									? uiColors.error
									: uiColors.textSecondary
							}
						>
							{bodyMessage()}
						</text>
					}
				>
					<box
						style={{
							width: "100%",
							flexGrow: 1,
							minHeight: 0,
							flexDirection: "row",
							gap: 1,
						}}
					>
						<box
							{...listWheel}
							style={{
								width: "38%",
								minWidth: 0,
								height: "100%",
								flexDirection: "column",
								overflow: "hidden",
							}}
						>
							<For each={listRows()}>
								{(request) => {
									const index = () => props.requests.indexOf(request);
									const selected = () => index() === props.selectedIndex;
									const mouse = useRowMouse({
										gesture,
										index: index(),
										selectedIndex: () => props.selectedIndex,
										activatable: () => props.onSelectIndex !== undefined,
										onSelect: (row: number) => props.onSelectIndex?.(row),
										onActivate: () => dispatch("Enter"),
									});
									const hover = useHover(mouse.onMouseOut);
									return (
										<box
											{...mouse}
											{...hover}
											width="100%"
											height={1}
											overflow="hidden"
											backgroundColor={
												!selected() && hover.hovered()
													? uiColors.bgHover
													: undefined
											}
										>
											<text
												fg={
													selected() || hover.hovered()
														? uiColors.primary
														: uiColors.textSecondary
												}
												attributes={selected() ? TextAttributes.BOLD : 0}
												wrapMode="none"
												truncate
											>
												{debugRequestRowLabel(request)}
											</text>
										</box>
									);
								}}
							</For>
						</box>
						<box
							{...reportWheel}
							style={{
								flexGrow: 1,
								flexBasis: 0,
								minWidth: 0,
								height: "100%",
								flexDirection: "column",
								overflow: "hidden",
							}}
						>
							<Show
								when={selected() !== undefined}
								fallback={
									<text fg={uiColors.textMuted}>
										Select a request to read its report.
									</text>
								}
							>
								<For each={window().visible}>
									{(line) => (
										<box width="100%" height={1} overflow="hidden">
											<text
												fg={
													line.startsWith("# ")
														? uiColors.accent
														: uiColors.textSecondary
												}
												wrapMode="none"
												truncate
											>
												{line}
											</text>
										</box>
									)}
								</For>
							</Show>
						</box>
					</box>
				</Show>
			</box>
		</GenericModal>
	);
}
