/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, For, onCleanup } from "solid-js";
import {
	HelpText,
	wrapHelpEntries,
} from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { SearchHeader } from "../presentation/components/SearchHeader.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";
import type { LocalNotice } from "./notifications.ts";

/** Original error-dialog sizing/header/scroll presentation over a local immutable
 * report. Dismissal never resolves a review, retries an operation or approves. */
export function MessageDialog(props: {
	item: LocalNotice;
	active: boolean;
	close: (item: LocalNotice) => void;
}) {
	const dimensions = useTerminalDimensions();
	const item = props.item;
	const width = () => Math.max(1, Math.floor(dimensions().width * 0.7));
	const height = () => Math.max(1, Math.floor(dimensions().height * 0.55));
	const footer = createMemo(() =>
		wrapHelpEntries(
			[
				{ key: "j/k", action: "Scroll" },
				{ key: "PgUp/PgDn", action: "Page" },
				{ key: "Home/End", action: "First/last" },
				{ key: "Esc", action: "Close" },
			],
			Math.max(1, width() - 4),
		),
	);
	let disposed = false;
	let scroll: ScrollBoxRenderable | undefined;
	const enabled = () => !disposed && props.active && props.item === item;
	const close = () => {
		if (enabled())
			queueMicrotask(() => {
				if (enabled()) props.close(item);
			});
	};
	const move = (dy: number) => {
		if (enabled()) scroll?.scrollBy(dy);
	};
	const page = () =>
		Math.max(1, scroll?.viewport.height ?? height() - 4 - footer().length);
	const edge = (last: boolean) => {
		if (enabled())
			scroll?.scrollTo(
				last ? Math.max(0, scroll.scrollHeight - scroll.viewport.height) : 0,
			);
	};
	const unregister = useKeymap().registerLayer({
		id: `v2.diagnostic.${item.id}`,
		priority: 200,
		enabled,
		bindings: [
			{ key: "escape", cmd: close },
			{ key: "pageup", cmd: () => move(-page()) },
			{ key: "pagedown", cmd: () => move(page()) },
			{ key: "home", cmd: () => edge(false) },
			{ key: "end", cmd: () => edge(true) },
			...[
				["j", 1],
				["down", 1],
				["k", -1],
				["up", -1],
			].map(([key, dy]) => ({ key: String(key), cmd: () => move(Number(dy)) })),
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		scroll = undefined;
	});
	return (
		<ReadOnlyModalFrame
			width={width()}
			height={height()}
			close={close}
			active={enabled()}
			footerHeight={footer().length + 1}
			header={
				<SearchHeader>
					<text
						fg={item.type === "error" ? uiColors.error : uiColors.primary}
						attributes={TextAttributes.BOLD}
					>
						{item.type === "error" ? "✗ " : "ℹ "}Local client diagnostic
					</text>
				</SearchHeader>
			}
			footer={
				<>
					<For each={footer()}>
						{(entries) => (
							<HelpText
								entries={entries}
								activatable={(entry) => enabled() && entry.key === "Esc"}
								onActivate={(entry) => {
									if (entry.key === "Esc") close();
								}}
							/>
						)}
					</For>
					<text fg={uiColors.textMuted} truncate>
						Read-only display; no native acknowledgement, retry or approval.
					</text>
				</>
			}
		>
			<scrollbox
				ref={(node) => {
					scroll = node;
				}}
				flexGrow={1}
				minHeight={0}
				width="100%"
				paddingTop={1}
			>
				<text fg={uiColors.textMuted} wrapMode="word">
					Origin: {item.origin} · received locally {item.receivedAt} (epoch ms).
					Cached report, not current native state or an authoritative receipt.
				</text>
				<text fg={uiColors.textPrimary} wrapMode="word">
					{item.message}
				</text>
			</scrollbox>
		</ReadOnlyModalFrame>
	);
}
