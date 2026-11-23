/** @jsxImportSource @opentui/solid */
import { errorCopy } from "../errors.ts";
import type { Theme } from "../opencode-types.ts";
import { Spinner } from "./Spinner.tsx";

export function ErrorView(props: { theme: Theme; message?: string }) {
	const copy = () => errorCopy(props.message);
	return (
		<box flexDirection="column" flexGrow={1} gap={1} paddingTop={1}>
			<text fg={props.theme.text.feedback.error.base}>
				<b>{copy().title}</b>
			</text>
			<text fg={props.theme.text.base} wrapMode="word">
				{props.message ?? "request failed"}
			</text>
			<text fg={props.theme.text.muted} wrapMode="word">
				{copy().hint}
			</text>
		</box>
	);
}

export function LoadingView(props: { theme: Theme }) {
	return (
		<box flexDirection="column" flexGrow={1} gap={1} paddingTop={1}>
			<Spinner theme={props.theme} label="Loading capabilities…" />
			<text fg={props.theme.text.muted} wrapMode="word">
				The capability list is read over the local loopback API.
			</text>
		</box>
	);
}

export function RunningView(props: { theme: Theme; label: string }) {
	return (
		<box
			flexDirection="column"
			flexGrow={1}
			justifyContent="center"
			alignItems="center"
			gap={1}
		>
			<Spinner theme={props.theme} label={`Running ${props.label}…`} />
			<text fg={props.theme.text.muted}>Esc cancels the request</text>
		</box>
	);
}
