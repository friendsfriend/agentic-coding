/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, For, onCleanup, Show } from "solid-js";
import type {
	Data,
	Transcript as TranscriptData,
} from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { color } from "../../ui/theme/index.ts";

export function Transcript(props: {
	value: TranscriptData | null;
	expanded: string[];
	toggle: (id: string) => void;
}) {
	const renderer = useRenderer();
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
			"markup.strong": { fg: color("text"), bold: true },
			"markup.raw": { fg: color("accent") },
		},
		renderer.nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const messages = createMemo<Data[]>(() =>
		(props.value?.entries ?? []).flatMap((entry) =>
			dataList(entry.model).map((message, index) => ({
				...message,
				identity: `${entry.id}:${index}`,
			})),
		),
	);
	const text = (message: Data) =>
		typeof message.content === "string"
			? message.content
			: dataList(message.content)
					.filter((part) => part.type === "text")
					.map((part) => String(part.text ?? ""))
					.join("\n");
	return (
		<box flexDirection="column" gap={1}>
			<Show when={props.value?.truncated}>
				<text fg={color("warning")}>
					Showing the newest 200 native entries.
				</text>
			</Show>
			<For each={messages()}>
				{(message) => (
					<>
						<Show when={text(message) && message.role !== "toolResult"}>
							<box
								flexDirection="column"
								paddingLeft={1}
								paddingRight={1}
								backgroundColor={
									message.role === "user"
										? color("backgroundPanel")
										: color("background")
								}
								border={message.role === "user" ? ["left"] : false}
								borderColor={color("accent")}
							>
								<text fg={color("textMuted")}>{String(message.role)}</text>
								<markdown
									content={text(message)}
									syntaxStyle={syntax}
									conceal={true}
								/>
							</box>
						</Show>
						<For
							each={dataList(message.content).filter(
								(part) => part.type === "thinking" || part.type === "toolCall",
							)}
						>
							{(part, index) => {
								const id = `${message.identity}:${index()}`;
								return (
									<box
										flexDirection="column"
										border={["left"]}
										borderColor={color("accent")}
										backgroundColor={color("backgroundPanel")}
										paddingLeft={1}
										onMouseDown={() => props.toggle(id)}
									>
										<text fg={color("accent")}>
											{part.type === "thinking"
												? "Thinking…"
												: `${props.expanded.includes(id) ? "▾" : "▸"} ${String(part.name ?? "tool")}`}
										</text>
										<Show when={props.expanded.includes(id)}>
											<text wrapMode="word">
												{part.type === "thinking"
													? String(part.thinking ?? "")
													: JSON.stringify(part.arguments, null, 2)}
											</text>
										</Show>
									</box>
								);
							}}
						</For>
						<Show when={message.role === "toolResult"}>
							<box
								border={["left"]}
								borderColor={message.isError ? color("error") : color("border")}
								paddingLeft={1}
							>
								<text wrapMode="word">{text(message)}</text>
							</box>
						</Show>
					</>
				)}
			</For>
			<Show when={!messages().length}>
				<text fg={color("textMuted")}>No retained transcript entries.</text>
			</Show>
		</box>
	);
}
