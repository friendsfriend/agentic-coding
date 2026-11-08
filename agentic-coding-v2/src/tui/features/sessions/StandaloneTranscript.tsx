/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import type {
	StandaloneMode,
	StandaloneSession,
} from "../../../protocol/standalone.ts";
import { AssistantMarkdown } from "../../presentation/components/AssistantMarkdown.tsx";
import { markdownBlockParts } from "../../presentation/components/markdownBlocks.ts";
import { UserPrompt } from "../../presentation/components/UserPrompt.tsx";
import { color } from "../../ui/theme/index.ts";
import { SessionMarkdownCache } from "./session-markdown-cache.ts";

/** Presentation only. Retained rows survive unchanged observation polls; changed
 * bytes/indexes replace a row instead of inheriting another message's fold. */
export function StandaloneTranscript(props: {
	mode: StandaloneMode;
	sessionId: string;
	interactive: boolean;
	scope: object;
	messages: StandaloneSession["messages"];
	partial: string | null;
	busy: boolean;
}) {
	type Message = StandaloneSession["messages"][number];
	let retained = new Map<number, { signature: string; value: Message }>();
	const markdownCache = new SessionMarkdownCache();
	let scope: string | undefined;
	const key = (index: number) =>
		JSON.stringify(["standalone", props.mode, props.sessionId, index]);
	const messages = createMemo(() => {
		const identity = JSON.stringify([props.mode, props.sessionId]);
		if (scope !== identity) {
			scope = identity;
			retained.clear();
			markdownCache.clear();
		}
		const next = new Map<number, { signature: string; value: Message }>();
		const rows = props.messages.map((message, index) => {
			const signature = JSON.stringify(message);
			const previous = retained.get(index);
			const entry =
				previous?.signature === signature
					? previous
					: { signature, value: message };
			next.set(index, entry);
			return entry.value;
		});
		retained = next;
		return rows;
	});
	createEffect(() =>
		markdownCache.retain(new Set(messages().map((_, index) => key(index)))),
	);
	onCleanup(() => markdownCache.clear());
	return (
		<box flexDirection="column" gap={1}>
			<For each={messages()}>
				{(message, index) => {
					const [expanded, setExpanded] = createSignal(false);
					return (
						<Show
							when={message.role === "user"}
							fallback={
								<box paddingLeft={3} paddingRight={1} flexShrink={0}>
									<AssistantMarkdown
										transcript={(key, text) => markdownCache.parts(key, text)}
										partKey={key(index())}
										text={message.content}
										fg={color("text")}
									/>
								</box>
							}
						>
							<UserPrompt
								scope={props.scope}
								interactive={props.interactive}
								keyboard
								text={message.content}
								expanded={expanded()}
								onToggle={() => setExpanded((value) => !value)}
							/>
						</Show>
					);
				}}
			</For>
			<Show when={props.partial !== null && props.busy}>
				<box
					flexDirection="column"
					paddingLeft={3}
					paddingRight={1}
					flexShrink={0}
				>
					<text fg={color("warning")}>
						Native in-flight text (volatile, clipped, not retained completion
						evidence)
					</text>
					<AssistantMarkdown
						// This contract has no native generation/attempt ID. Reparse supplied
						// volatile text instead of borrowing another attempt's settled cache.
						transcript={(_key, text) => markdownBlockParts(text)}
						partKey={JSON.stringify([
							"standalone",
							props.mode,
							props.sessionId,
							"volatile",
						])}
						text={props.partial ?? ""}
						fg={color("text")}
						live
					/>
				</box>
			</Show>
		</box>
	);
}
