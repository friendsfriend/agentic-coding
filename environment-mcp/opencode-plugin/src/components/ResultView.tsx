/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { onMount } from "solid-js";
import type { UiActionDescriptor } from "../../../src/ui/capability-api.ts";
import type { Theme } from "../opencode-types.ts";

export function ResultView(props: {
	theme: Theme;
	action: UiActionDescriptor;
	result: string;
}) {
	let scroll: ScrollBoxRenderable | undefined;
	onMount(() => queueMicrotask(() => scroll?.focus()));
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none" truncate flexGrow={1}>
					<b>{props.action.label}</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					result
				</text>
			</box>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				verticalScrollbarOptions={{ visible: false }}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text
					fg={props.theme.text.base}
					wrapMode="word"
					selectable
					paddingRight={1}
				>
					{props.result}
				</text>
			</scrollbox>
		</box>
	);
}
