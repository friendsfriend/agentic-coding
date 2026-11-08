/** @jsxImportSource @opentui/solid */
import { type MouseEvent, RGBA, TextAttributes } from "@opentui/core";
import { Portal } from "@opentui/solid";
import { createEffect, createMemo, For } from "solid-js";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors.ts";
import { HelpText, wrapHelpEntries } from "./HelpText.tsx";
import {
	type HelpModalRow,
	helpModalRows,
	type KeybindSection,
} from "./keybinds.ts";
import {
	classifyPointerGesture,
	isPrimaryPointerButton,
	type PointerSample,
} from "./mouse/clickSemantics.ts";
import { useKeybindChips } from "./mouse/useKeybindChips.ts";
import { useWheelScroll } from "./mouse/useWheelScroll.ts";
import { SearchHeader } from "./SearchHeader.tsx";

/** Original HelpModal and GenericModal's read-only framing branch. Catalog,
 * offset and dismissal are supplied by the native caller, never legacy stores.
 * This frame cannot host drafts, confirmations or mutating actions. */
export function HelpModal(props: {
	title: string;
	sections: KeybindSection[];
	offset: number;
	onOffset: (offset: number) => void;
	onLines: (lines: number) => void;
	onRows: (rows: number) => void;
	close: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const chips = useKeybindChips();
	const width = () => Math.max(1, Math.floor(dimensions().width * 0.72));
	const height = () => Math.max(1, Math.floor(dimensions().height * 0.78));
	const footer = createMemo(() =>
		wrapHelpEntries(
			[
				{ key: "j/k", action: "Navigate" },
				{ key: "Esc", action: "Close" },
			],
			Math.max(1, width() - 4),
		),
	);
	const lines = () => Math.max(1, height() - 2 - 1 - footer().length);
	createEffect(() => props.onLines(lines()));
	// Native command descriptions can be longer than the legacy catalog. Split
	// them into visual rows before windowing so End/wheel can reach every line.
	const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const rows = createMemo(() =>
		helpModalRows(props.sections).flatMap<HelpModalRow>((row) => {
			if ("title" in row) return [row];
			const available = Math.max(
				1,
				width() - 5 - Math.max(14, Bun.stringWidth(row.key)),
			);
			const lines: string[] = [];
			let line = "";
			for (const { segment } of segments.segment(row.action)) {
				if (segment === "\n") {
					lines.push(line);
					line = "";
					continue;
				}
				if (line && Bun.stringWidth(line + segment) > available) {
					if (segment === " ") {
						lines.push(line.trimEnd());
						line = "";
						continue;
					}
					const boundary = line.lastIndexOf(" ");
					if (boundary > 0) {
						lines.push(line.slice(0, boundary).trimEnd());
						line = line.slice(boundary + 1);
					} else {
						lines.push(line);
						line = "";
					}
				}
				line += segment;
			}
			lines.push(line);
			return lines.map((action, index) => ({
				...row,
				key:
					index === 0
						? row.key
						: " ".repeat(Bun.stringWidth(row.key.padEnd(14))),
				action,
			}));
		}),
	);
	createEffect(() => props.onRows(rows().length));
	const visible = () => rows().slice(props.offset, props.offset + lines());
	const wheel = useWheelScroll({
		enabled: () => rows().length > lines(),
		onScroll: (direction, delta) =>
			props.onOffset(
				Math.max(
					0,
					Math.min(
						rows().length - lines(),
						props.offset + (direction === "up" ? -delta : delta),
					),
				),
			),
	});
	const onBackdropArea = (event: MouseEvent) =>
		event.target === undefined || event.target === event.currentTarget;
	let backdropDown: PointerSample | undefined;
	const backdropMouseDown = (event: MouseEvent) => {
		backdropDown = undefined;
		if (!isPrimaryPointerButton(event.button) || !onBackdropArea(event)) return;
		backdropDown = { x: event.x, y: event.y };
	};
	const backdropMouseUp = (event: MouseEvent) => {
		const start = backdropDown;
		backdropDown = undefined;
		if (!isPrimaryPointerButton(event.button) || !onBackdropArea(event)) return;
		if (classifyPointerGesture(start, { x: event.x, y: event.y }) !== "tap")
			return;
		props.close();
		event.stopPropagation();
	};
	return (
		<Portal
			ref={(el) => {
				const portal = el as { position?: string; zIndex?: number };
				portal.position = "absolute";
				portal.zIndex = 100;
			}}
		>
			<box
				position="absolute"
				top={0}
				left={0}
				width={dimensions().width}
				height={dimensions().height}
				flexDirection="column"
				justifyContent="center"
				alignItems="center"
				backgroundColor={RGBA.fromValues(0, 0, 0, 0.35)}
				onMouseDown={backdropMouseDown}
				onMouseUp={backdropMouseUp}
				onMouseScroll={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<box
					backgroundColor={uiColors.bgMantle}
					width={width()}
					height={height()}
					flexDirection="column"
					paddingTop={1}
					paddingBottom={1}
					paddingLeft={2}
					paddingRight={2}
					onMouseUp={(event) => event.stopPropagation()}
				>
					<SearchHeader>
						<box width="100%" justifyContent="flex-start" flexDirection="row">
							<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
								{props.title}
							</text>
						</box>
					</SearchHeader>
					<box
						width="100%"
						flexDirection="column"
						flexGrow={1}
						flexShrink={1}
						minHeight={0}
						overflow="hidden"
						{...wheel}
					>
						<For each={visible()}>
							{(row) =>
								"title" in row ? (
									<text
										fg={uiColors.textPrimary}
										attributes={TextAttributes.BOLD}
										flexShrink={0}
									>
										{row.title}
									</text>
								) : (
									<box
										flexDirection="row"
										paddingLeft={1}
										flexShrink={0}
										height={1}
									>
										<text
											fg={uiColors.primary}
											attributes={TextAttributes.BOLD}
										>
											{row.key.padEnd(14)}
										</text>
										<text fg={uiColors.textPrimary} wrapMode="none">
											{row.action}
										</text>
									</box>
								)
							}
						</For>
					</box>
					<box
						width="100%"
						height={footer().length}
						justifyContent="flex-start"
						flexDirection="column"
						flexShrink={0}
					>
						<For each={footer()}>
							{(line) => (
								<HelpText
									entries={line}
									onActivate={chips.onActivate}
									activatable={chips.activatable}
								/>
							)}
						</For>
					</box>
				</box>
			</box>
		</Portal>
	);
}
