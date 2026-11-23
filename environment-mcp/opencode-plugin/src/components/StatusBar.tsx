/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { EnvironmentUiView } from "../../../src/ui/controller.ts";
import { footerKeybinds } from "../keybinds.ts";
import type { Theme } from "../opencode-types.ts";

function defaultMessage(view: EnvironmentUiView): string {
	switch (view) {
		case "loading":
			return "Connecting to environment-mcp…";
		case "list":
			return "Select a capability";
		case "form":
			return "Fill the inputs, then run";
		case "running":
			return "Working…";
		case "traces":
			return "Pick a trace to inspect";
		case "result":
			return "Result";
		case "error":
			return "Request failed";
	}
}

export function StatusBar(props: {
	theme: Theme;
	view: EnvironmentUiView;
	message?: string;
	tone?: "normal" | "error" | "warning" | "success";
	right?: string;
	searchFocused?: boolean;
}) {
	const color = () => {
		if (props.tone === "error") return props.theme.text.feedback.error.base;
		if (props.tone === "warning") return props.theme.text.feedback.warning.base;
		if (props.tone === "success") return props.theme.text.feedback.success.base;
		return props.theme.text.base;
	};
	return (
		<box
			flexShrink={0}
			flexDirection="column"
			backgroundColor={props.theme.background.raised.base}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
		>
			<box flexDirection="row" height={1} minWidth={0}>
				<text fg={color()} wrapMode="none" truncate flexShrink={1}>
					{props.message ?? defaultMessage(props.view)}
				</text>
				<box flexGrow={1} />
				<Show when={props.right}>
					<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
						{props.right}
					</text>
				</Show>
			</box>
			<box flexDirection="row" flexWrap="wrap" columnGap={2}>
				<For each={footerKeybinds(props.view, props.searchFocused)}>
					{(entry) => (
						<text wrapMode="none" flexShrink={0}>
							<span style={{ fg: props.theme.text.base }}>{entry.key}</span>{" "}
							<span style={{ fg: props.theme.text.muted }}>
								{entry.short ?? entry.action}
							</span>
						</text>
					)}
				</For>
			</box>
			{/* The app-wide feature footer overlays the terminal's final row. */}
			<box height={1} />
		</box>
	);
}
