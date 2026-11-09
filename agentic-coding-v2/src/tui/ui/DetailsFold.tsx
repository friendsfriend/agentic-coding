/** @jsxImportSource @opentui/solid */
// A details disclosure: the row states what is behind it in user language, and
// the exact supplied record is rendered only once the reader opens it. Native
// observations are detail, not the reading surface, so every page keeps its
// summaries visible and its records folded.
import { createSignal, type JSX, Show } from "solid-js";
import { ActionHeader } from "./ActionHeader.tsx";
import { color } from "./theme/index.ts";

export function DetailsFold(props: {
	label: string;
	summary?: string;
	/** Enclosing observation; a change retires the open state of the parent. */
	scope?: unknown;
	interactive?: boolean;
	/** Controlled openness, so a section fold can own the state. */
	open?: boolean;
	initiallyOpen?: boolean;
	onToggle?: () => void;
	children: JSX.Element;
}) {
	const [local, setLocal] = createSignal(props.initiallyOpen === true);
	const open = () => props.open ?? local();
	const toggle = () =>
		props.onToggle ? props.onToggle() : setLocal((value) => !value);
	return (
		<box flexDirection="column">
			<ActionHeader
				onActivate={toggle}
				interactive={props.interactive}
				scope={[props.scope, open()]}
			>
				<text fg={color("textMuted")}>
					{open() ? "▾" : "▸"} {props.label}
					{props.summary ? ` · ${props.summary}` : ""}
				</text>
			</ActionHeader>
			<Show when={open()}>{props.children}</Show>
		</box>
	);
}
