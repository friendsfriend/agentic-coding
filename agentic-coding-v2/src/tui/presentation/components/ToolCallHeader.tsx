/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import { useTap } from "./mouse/useTap.ts";
import { Spinner } from "./Spinner.tsx";
import { Stamp } from "./Stamp.tsx";

/** Original call-label/gutter/hint composition with explicit native observation
 * bindings. This presentation component cannot infer execution or start clocks. */
export function ToolCallHeader(props: {
	failed: boolean;
	pending: boolean;
	browser: boolean;
	icon: string;
	label: string;
	hint?: string;
	timestamp?: unknown;
	durationMs?: unknown;
	onToggle: () => void;
}) {
	const iconFg = () => (props.failed ? uiColors.error : uiColors.textMuted);
	return (
		<box
			flexDirection="row"
			{...useTap(props.onToggle, { stopPropagation: true })}
		>
			<box width={props.browser ? 3 : 2} flexShrink={0} flexDirection="row">
				<Show when={props.browser}>
					<text fg={uiColors.textMuted} flexShrink={0}>
						{"\uf488"}
					</text>
				</Show>
				<Show
					when={props.pending}
					fallback={<text fg={iconFg()}>{props.icon}</text>}
				>
					<Spinner color={iconFg()} />
				</Show>
			</box>
			<text
				fg={props.failed ? uiColors.error : uiColors.textPrimary}
				flexGrow={1}
				minWidth={0}
				wrapMode="word"
			>
				{props.label}
			</text>
			<Show when={props.hint}>
				{(hint) => (
					<text
						fg={uiColors.textMuted}
						flexShrink={1}
						minWidth={0}
						maxWidth="45%"
						wrapMode="word"
					>{` ${hint()}`}</text>
				)}
			</Show>
			<Stamp
				timestamp={props.timestamp}
				durationMs={props.durationMs}
				clockLabel="result"
			/>
		</box>
	);
}
