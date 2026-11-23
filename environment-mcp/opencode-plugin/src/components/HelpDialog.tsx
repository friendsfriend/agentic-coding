/** @jsxImportSource @opentui/solid */
import { For, onMount } from "solid-js";
import { HELP_SECTIONS, type HelpSection } from "../keybinds.ts";
import type { Context, Theme } from "../opencode-types.ts";

function Section(props: { theme: Theme; section: HelpSection }) {
	return (
		<box flexDirection="column" gap={0}>
			<text fg={props.theme.text.feedback.info.base}>
				<b>{props.section.title}</b>
			</text>
			<For each={props.section.entries}>
				{(entry) => (
					<box flexDirection="row" gap={1} minWidth={0}>
						<text
							fg={props.theme.text.base}
							wrapMode="none"
							flexShrink={0}
							width={13}
						>
							{entry.key}
						</text>
						<text fg={props.theme.text.muted} wrapMode="word" flexGrow={1}>
							{entry.action}
						</text>
					</box>
				)}
			</For>
		</box>
	);
}

export function HelpDialog(props: { context: Context; theme: Theme }) {
	onMount(() => props.context.ui.dialog.set({ size: "large" }));
	return (
		<box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme.text.base}>
					<b>environment keys</b>
				</text>
				<text fg={props.theme.text.muted}>esc close</text>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				The same capability registry the agent uses. Approval stays on the
				operator surface.
			</text>
			<box flexDirection="row" gap={2} alignItems="flex-start">
				<box flexDirection="column" flexGrow={1} minWidth={0} gap={1}>
					<For each={HELP_SECTIONS.slice(0, 2)}>
						{(section) => <Section theme={props.theme} section={section} />}
					</For>
				</box>
				<box flexDirection="column" flexGrow={1} minWidth={0} gap={1}>
					<For each={HELP_SECTIONS.slice(2)}>
						{(section) => <Section theme={props.theme} section={section} />}
					</For>
				</box>
			</box>
		</box>
	);
}
