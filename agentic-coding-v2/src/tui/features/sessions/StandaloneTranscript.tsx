/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import type { StandaloneSession } from "../../../protocol/standalone.ts";
import { MarkdownViewer } from "../../presentation/components/MarkdownViewer.tsx";
import { UserPrompt } from "../../presentation/components/UserPrompt.tsx";
import { color } from "../../ui/theme/index.ts";

/** Presentation only. Retained rows survive unchanged observation polls; changed
 * bytes/indexes replace a row instead of inheriting another message's fold. */
export function StandaloneTranscript(props: {
	messages: StandaloneSession["messages"];
	partial: string | null;
	busy: boolean;
}) {
	type Message = StandaloneSession["messages"][number];
	let retained = new Map<number, { signature: string; value: Message }>();
	const messages = createMemo(() => {
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
	return (
		<box flexDirection="column" gap={1}>
			<For each={messages()}>
				{(message) => {
					const [expanded, setExpanded] = createSignal(false);
					return (
						<Show
							when={message.role === "user"}
							fallback={
								<box paddingLeft={3} paddingRight={1} flexShrink={0}>
									<MarkdownViewer
										content={message.content}
										fg={color("text")}
									/>
								</box>
							}
						>
							<UserPrompt
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
					<MarkdownViewer
						content={props.partial ?? ""}
						fg={color("text")}
						streaming
					/>
				</box>
			</Show>
		</box>
	);
}
