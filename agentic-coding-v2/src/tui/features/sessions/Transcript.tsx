/** @jsxImportSource @opentui/solid */
import { type BoxRenderable, SyntaxStyle } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { useRenderer } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import type {
	Data,
	Transcript as TranscriptData,
} from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { color } from "../../ui/theme/index.ts";
import { ToolCard } from "./ToolCard.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";

type Link = {
	result: Data | null;
	pairing: "matched" | "missing" | "ambiguous";
};
export function Transcript(props: {
	value: TranscriptData | null;
	enabled: boolean;
	selected: string | null;
	select: (id: string) => void;
	reveal: (node: BoxRenderable) => void;
	expanded: string[];
	toggle: (id: string) => void;
}) {
	const renderer = useRenderer(),
		keymap = useKeymap();
	const anchors = new Map<string, BoxRenderable>();
	const anchor = (id: string) => {
		let previous: BoxRenderable | undefined;
		return (node: BoxRenderable | null) => {
			if (node) {
				previous = node;
				anchors.set(id, node);
			} else if (anchors.get(id) === previous) anchors.delete(id);
		};
	};
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
			"markup.strong": { fg: color("text"), bold: true },
			"markup.raw": { fg: color("accent") },
			keyword: { fg: color("primary") },
			string: { fg: color("success") },
			comment: { fg: color("textMuted") },
			number: { fg: color("accent") },
			function: { fg: color("primary") },
		},
		renderer.nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const messages = createMemo<Data[]>(() =>
		(props.value?.entries ?? []).flatMap((entry) =>
			dataList(entry.model).map((message, index) => ({
				...message,
				identity: `${props.value?.id}:${entry.id}:${index}`,
				nativeDiagnostics: dataList(
					entry.data &&
						typeof entry.data === "object" &&
						!Array.isArray(entry.data)
						? (entry.data as Data).diagnostics
						: undefined,
				),
			})),
		),
	);
	const parts = (message: Data) =>
		dataList(message.content).map((part, index) => ({
			part,
			identity: `${message.identity}:${index}`,
		}));
	// Call IDs are opaque. Only unique call/result pairs with the same name are
	// associated. A clipped window or reused ID never implies running/success.
	const associations = createMemo(() => {
		const calls = messages()
			.filter((message) => message.role === "assistant")
			.flatMap(parts)
			.filter(({ part }) => part.type === "toolCall");
		const results = messages().filter(
			(message) => message.role === "toolResult",
		);
		const callCounts = new Map<string, number>(),
			resultGroups = new Map<string, Data[]>();
		for (const { part } of calls)
			if (typeof part.id === "string")
				callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1);
		for (const result of results)
			if (typeof result.toolCallId === "string")
				resultGroups.set(result.toolCallId, [
					...(resultGroups.get(result.toolCallId) ?? []),
					result,
				]);
		const links = new Map<string, Link>(),
			consumed = new Set<string>();
		for (const { part, identity } of calls) {
			const candidates =
				typeof part.id === "string" ? (resultGroups.get(part.id) ?? []) : [];
			const unique =
				typeof part.id === "string" &&
				callCounts.get(part.id) === 1 &&
				candidates.length === 1;
			const candidate = unique ? candidates[0] : undefined;
			const matched =
				candidate && candidate.toolName === part.name ? candidate : null;
			links.set(identity, {
				result: matched,
				pairing: matched
					? "matched"
					: candidates.length
						? "ambiguous"
						: "missing",
			});
			if (matched) consumed.add(String(matched.identity));
		}
		return { links, consumed };
	});
	const controls = createMemo(() =>
		messages()
			.filter((message) => message.role === "assistant")
			.flatMap(parts)
			.filter(
				({ part }) => part.type === "toolCall" || part.type === "thinking",
			),
	);
	const enabled = createMemo(() => props.enabled);
	const selected = () =>
		controls().find((item) => item.identity === props.selected);
	const move = (direction: number) => {
		const rows = controls();
		if (!rows.length) return;
		const index = rows.findIndex((item) => item.identity === props.selected);
		const next =
			rows[
				index < 0
					? direction > 0
						? 0
						: rows.length - 1
					: Math.max(0, Math.min(rows.length - 1, index + direction))
			];
		if (!next) return;
		props.select(next.identity);
		const node = anchors.get(next.identity);
		if (node) props.reveal(node);
	};
	const toggleSection = (suffix: string) => {
		const row = selected();
		if (row?.part.type !== "toolCall") return;
		const result = associations().links.get(row.identity)?.result;
		if (suffix !== ":arguments" && !result) return;
		if (suffix === ":details" && result?.details === undefined) return;
		if (!props.expanded.includes(row.identity)) props.toggle(row.identity);
		props.toggle(`${row.identity}${suffix}`);
	};
	createEffect(() => {
		if (!enabled()) return;
		const unregister = untrack(() =>
			keymap.registerLayer({
				id: "v2.transcript",
				priority: 30,
				commands: [
					{
						id: "transcript.previous",
						name: "Previous retained thinking/tool card",
						run: () => move(-1),
					},
					{
						id: "transcript.next",
						name: "Next retained thinking/tool card",
						run: () => move(1),
					},
					{
						id: "transcript.toggle",
						name: "Toggle selected retained card",
						run: () => {
							const row = selected();
							if (row) props.toggle(row.identity);
						},
					},
					...[
						["arguments", ":arguments"],
						["output", ":output"],
						["details", ":details"],
					].map(([name, suffix]) => ({
						id: `transcript.${name}`,
						name: `Toggle native ${name}`,
						run: () => toggleSection(suffix ?? ""),
					})),
				],
				bindings: [
					{ key: "ctrl+up", cmd: "transcript.previous" },
					{ key: "ctrl+down", cmd: "transcript.next" },
					{ key: "ctrl+o", cmd: "transcript.toggle" },
					{ key: "ctrl+alt+a", cmd: "transcript.arguments" },
					{ key: "ctrl+alt+o", cmd: "transcript.output" },
					{ key: "ctrl+alt+d", cmd: "transcript.details" },
				],
			}),
		);
		onCleanup(unregister);
	});
	const text = (message: Data) =>
		typeof message.content === "string"
			? message.content
			: dataList(message.content)
					.filter((part) => part.type === "text")
					.map((part) => (typeof part.text === "string" ? part.text : ""))
					.join("\n");
	return (
		<box flexDirection="column" gap={1}>
			<Show when={controls().length}>
				<text fg={color("textMuted")}>
					Ctrl+↑/↓: retained cards · Ctrl+O: expand · Ctrl+Alt+A/O/D:
					arguments/output/details
				</text>
			</Show>
			<Show when={props.selected && !selected()}>
				<text fg={color("warning")}>
					Saved card is outside this retained history. Selection is not replaced
					automatically; choose a retained card explicitly.
				</text>
			</Show>
			<Show when={props.value?.truncated}>
				<text fg={color("warning")}>
					Showing the newest 200 native entries. Unpaired tool activity is
					unknown outside this history window.
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
							each={parts(message).filter(
								({ part }) =>
									message.role === "assistant" &&
									(part.type === "thinking" || part.type === "toolCall"),
							)}
						>
							{({ part, identity }) => {
								const track = anchor(identity);
								return (
									<Show
										when={part.type === "toolCall"}
										fallback={
											<box
												flexDirection="column"
												border={["left"]}
												borderColor={color("accent")}
												backgroundColor={color("backgroundPanel")}
												paddingLeft={1}
											>
												<TranscriptHeader
													identity={identity}
													select={props.select}
													toggle={props.toggle}
													anchor={track}
												>
													<text fg={color("accent")}>
														{props.selected === identity ? "› " : ""}
														{props.expanded.includes(identity) ? "▾" : "▸"}{" "}
														Retained thinking
													</text>
												</TranscriptHeader>
												<Show when={props.expanded.includes(identity)}>
													<markdown
														content={
															typeof part.thinking === "string"
																? part.thinking
																: ""
														}
														syntaxStyle={syntax}
														conceal={true}
													/>
												</Show>
											</box>
										}
									>
										<ToolCard
											identity={identity}
											selected={props.selected === identity}
											select={props.select}
											anchor={track}
											call={part}
											result={
												associations().links.get(identity)?.result ?? null
											}
											pairing={
												associations().links.get(identity)?.pairing ?? "missing"
											}
											expanded={props.expanded}
											toggle={props.toggle}
											syntax={syntax}
										/>
									</Show>
								);
							}}
						</For>
						<Show
							when={
								message.role === "toolResult" &&
								!associations().consumed.has(String(message.identity))
							}
						>
							<box
								flexDirection="column"
								border={["left"]}
								borderColor={
									message.isError === true ? color("error") : color("border")
								}
								paddingLeft={1}
							>
								<text fg={color("warning")}>
									Unpaired retained result ·{" "}
									{String(message.toolName ?? "tool")} ·{" "}
									{String(message.toolCallId ?? "identity unavailable")} — no
									unique call in this window.
								</text>
								<text wrapMode="word">
									{text(message) || "No text output retained."}
								</text>
								<Show when={message.details !== undefined}>
									<code
										content={JSON.stringify(message.details, null, 2)}
										filetype="json"
										syntaxStyle={syntax}
										drawUnstyledText={true}
										wrapMode="word"
									/>
								</Show>
							</box>
						</Show>
						<For
							each={dataList(message.content).filter(
								(part) =>
									part.type === "image" &&
									(message.role !== "toolResult" ||
										!associations().consumed.has(String(message.identity))),
							)}
						>
							{(part) => (
								<text fg={color("textMuted")}>
									Retained image ({String(part.mimeType ?? "unknown format")});
									inline terminal image rendering is not implemented.
								</text>
							)}
						</For>
					</>
				)}
			</For>
			<Show when={!messages().length}>
				<text fg={color("textMuted")}>No retained transcript entries.</text>
			</Show>
		</box>
	);
}
