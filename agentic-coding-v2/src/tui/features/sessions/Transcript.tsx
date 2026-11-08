/** @jsxImportSource @opentui/solid */
import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	untrack,
} from "solid-js";
import type {
	Data,
	ToolProgress,
	Transcript as TranscriptData,
} from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { AssistantMarkdown } from "../../presentation/components/AssistantMarkdown.tsx";
import { MarkdownViewer } from "../../presentation/components/MarkdownViewer.tsx";
import { useMarkdownSyntaxStyle } from "../../presentation/components/markdownSyntax.ts";
import { Spinner } from "../../presentation/components/Spinner.tsx";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import { UserPrompt } from "../../presentation/components/UserPrompt.tsx";
import { createKeyedItems } from "../../presentation/components/utils/keyedItems.ts";
import { ImageView } from "../../ui/ImageView.tsx";
import { bindings, transcriptKeybinds } from "../../ui/keybinds.ts";
import { color } from "../../ui/theme/index.ts";
import { SessionMarkdownCache } from "./session-markdown-cache.ts";
import { ToolCard } from "./ToolCard.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";

type Link = {
	result: Data | null;
	pairing: "matched" | "missing" | "ambiguous";
};
export function Transcript(props: {
	value: TranscriptData | null;
	observation: "none" | "resynchronizing" | "watching" | "unavailable";
	observationError: string | null;
	enabled: boolean;
	selected: string | null;
	freezeWindow?: boolean;
	select: (id: string) => void;
	reveal: (node: BoxRenderable) => void;
	registerReadingRows?: (
		rows: ReadonlyMap<string, BoxRenderable>,
	) => () => void;
	onPromptTimeline?: (
		rows: ReadonlyMap<string, BoxRenderable>,
		items: { key: string; label: string }[],
	) => void;
	expanded: string[];
	toggle: (id: string) => void;
}) {
	const keymap = useKeymap();
	const anchors = new Map<string, BoxRenderable>();
	onMount(() => {
		const unregister = props.registerReadingRows?.(anchors);
		if (unregister) onCleanup(unregister);
	});
	const anchor = (id: string) => {
		let previous: BoxRenderable | undefined;
		return (node: BoxRenderable | null) => {
			if (node) {
				previous = node;
				anchors.set(id, node);
			} else if (anchors.get(id) === previous) anchors.delete(id);
		};
	};
	// Shared presentation styles belong to the native renderer, not this view.
	const syntax = useMarkdownSyntaxStyle();
	const progress = () =>
		props.observation === "watching" ? props.value?.progress : undefined;
	// Equal retained records keep their render identity across progress publications.
	// Changed bytes always replace the cached value; cache is pruned with the window.
	let retainedCache = new Map<string, { signature: string; value: Data }>();
	const retainedRenderKeys = new WeakMap<Data, string>();
	let retainedWindow: {
		id: number;
		entries: TranscriptData["entries"];
		truncated: boolean;
	} | null = null;
	const window = createMemo(() => {
		const value = props.value;
		if (!value) {
			retainedWindow = null;
			return null;
		}
		if (!props.freezeWindow || retainedWindow?.id !== value.id)
			retainedWindow = {
				id: value.id,
				entries: value.entries.slice(-200),
				truncated: value.truncated || value.entries.length > 200,
			};
		return retainedWindow;
	});
	const messages = createMemo<Data[]>(() => {
		const nextCache = new Map<string, { signature: string; value: Data }>();
		const retained = (window()?.entries ?? []).flatMap((entry) =>
			dataList(entry.model).map((message, index) => {
				const value = {
					...message,
					identity: `${props.value?.id}:${entry.id}:${index}`,
					nativePartial: false,
					nativeTaskId: entry.byTaskId,
					nativeEntryId: entry.id,
					nativeDiagnostics: dataList(
						entry.data &&
							typeof entry.data === "object" &&
							!Array.isArray(entry.data)
							? (entry.data as Data).diagnostics
							: undefined,
					),
				};
				const signature = JSON.stringify(value);
				const previous = retainedCache.get(value.identity);
				const cached =
					previous?.signature === signature ? previous : { signature, value };
				nextCache.set(value.identity, cached);
				retainedRenderKeys.set(cached.value, cached.signature);
				return cached.value;
			}),
		);
		retainedCache = nextCache;
		const live = progress();
		const message = live?.generation?.message;
		return live?.run && live.generation && message?.role === "assistant"
			? [
					...retained,
					{
						...message,
						identity: `${props.value?.id}:live:${live.run.taskId}:${live.generation.attempt}`,
						nativePartial: true,
						nativeDiagnostics: [],
					},
				]
			: retained;
	});
	const parts = (message: Data) =>
		(typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: dataList(message.content)
		).map((part, index) => ({
			part,
			identity: `${message.identity}:${index}`,
		}));
	// Retained byte changes replace their row. Only a live generation with the
	// same native task/attempt identity updates its mounted presentation carrier.
	const messageSlots = createKeyedItems(messages, (message) =>
		message.nativePartial === true
			? JSON.stringify([message.identity, "live"])
			: (retainedRenderKeys.get(message) ?? JSON.stringify(message)),
	);
	const markdownCache = new SessionMarkdownCache();
	createEffect(() => {
		markdownCache.retain(
			new Set(
				messages()
					.filter((message) => message.role === "assistant")
					.flatMap(parts)
					.filter(({ part }) => part.type === "text")
					.map(({ identity }) => identity),
			),
		);
	});
	onCleanup(() => markdownCache.clear());
	const liveLinks = createMemo(() => {
		const slots = progress()?.tools ?? [];
		const owner = progress()?.run?.taskId;
		const calls =
			owner === undefined
				? []
				: messages()
						.filter(
							(message) =>
								message.role === "assistant" &&
								message.nativePartial !== true &&
								message.nativeTaskId === owner &&
								message.stopReason !== "error" &&
								message.stopReason !== "aborted",
						)
						.flatMap(parts);
		const linked = new Map<string, ToolProgress>();
		const consumed = new Set<ToolProgress>();
		for (const slot of slots) {
			const matches = calls.filter(
				({ part }) => part.type === "toolCall" && part.id === slot.callId,
			);
			const match = matches[0];
			if (
				matches.length === 1 &&
				match?.part.name === slot.name &&
				slots.filter((other) => other.callId === slot.callId).length === 1
			) {
				linked.set(match.identity, slot);
				consumed.add(slot);
			}
		}
		return { linked, consumed };
	});
	const standalone = createMemo(() =>
		[
			...(progress()?.tools ?? []).filter(
				(slot) => !liveLinks().consumed.has(slot),
			),
			...(progress()?.nestedTools ?? []),
		].map((slot, index) => ({
			slot,
			identity: `${props.value?.id}:live-tool:${progress()?.run?.taskId ?? "unassociated"}:${slot.taskId ?? slot.entry ?? `pending:${slot.callId}:${index}`}`,
			part: { type: "liveTool" },
		})),
	);
	// Call IDs are opaque. Only unique call/result pairs with the same name are
	// associated. A clipped window or reused ID never implies running/success.
	const associations = createMemo(() => {
		const calls = messages()
			.filter(
				(message) =>
					message.role === "assistant" && message.nativePartial !== true,
			)
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
			const slot = liveLinks().linked.get(identity);
			const pointed =
				slot?.entry === undefined
					? []
					: results.filter(
							(result) =>
								result.nativeEntryId === slot.entry &&
								result.toolCallId === slot.callId &&
								result.toolName === slot.name,
						);
			const matched =
				pointed.length === 1
					? (pointed[0] ?? null)
					: candidate && candidate.toolName === part.name
						? candidate
						: null;
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
	const controls = createMemo(() => [
		...messages()
			.filter((message) => message.role === "assistant")
			.flatMap(parts)
			.filter(
				({ part }) => part.type === "toolCall" || part.type === "thinking",
			),
		...standalone(),
	]);
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
		if (!row || (row.part.type !== "toolCall" && row.part.type !== "liveTool"))
			return;
		const slot =
			liveLinks().linked.get(row.identity) ??
			standalone().find((item) => item.identity === row.identity)?.slot;
		const result = associations().links.get(row.identity)?.result;
		if (suffix === ":output" && !result && slot?.output === undefined) return;
		if (
			suffix === ":details" &&
			result?.details === undefined &&
			slot?.details === undefined
		)
			return;
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
						name: "Previous observed thinking/tool card",
						run: () => move(-1),
					},
					{
						id: "transcript.next",
						name: "Next observed thinking/tool card",
						run: () => move(1),
					},
					{
						id: "transcript.toggle",
						name: "Toggle selected observed card",
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
				bindings: bindings(transcriptKeybinds),
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
	createEffect(() => {
		props.onPromptTimeline?.(
			anchors,
			messageSlots()
				.map((slot) => slot.value())
				.filter(
					(message) =>
						message.role === "user" && text(message).trim().length > 0,
				)
				.slice(-200)
				.map((message) => ({
					key: JSON.stringify(["reading-message", message.identity]),
					label: Array.from(text(message).replace(/\s+/g, " ").trim())
						.slice(0, 512)
						.join(""),
				})),
		);
	});
	return (
		<box flexDirection="column" gap={1}>
			<text
				fg={
					props.observation === "watching"
						? color("textMuted")
						: color("warning")
				}
			>
				{props.observation === "watching"
					? "Watching native commits · last observed projection (not an atomic revision)"
					: `Native activity unknown · observation ${props.observation}`}
				{props.observationError ? ` · ${props.observationError}` : ""}
			</text>
			<Show when={props.freezeWindow && window()}>
				<text fg={color("warning")} wrapMode="word">
					Frozen bounded retained-history window while reading. Newer commits
					may be outside this display; header usage/counters and live activity
					below describe the separately supplied current projection, not this
					frozen window. Jump to latest to release the window.
				</text>
			</Show>
			<Show when={progress()}>
				{(live) => (
					<>
						<text fg={color("textMuted")}>
							{live().run
								? `Native run task #${live().run?.taskId} · inputs ${live().run?.inputs.join(", ")}`
								: "No native run recorded in this observation"}{" "}
							· queued inputs {live().inbox.length}
						</text>
						<Show when={live().generation}>
							{(generation) => (
								<text fg={color("textMuted")}>
									Native generation · attempt {generation().attempt} · committed
									partials only
									{generation().retry
										? ` · retry recorded at ${generation().retry?.at}: ${generation().retry?.error}`
										: ""}
									{generation().deferred
										? ` · deferred poll recorded at ${generation().deferred?.pollAt}`
										: ""}
								</text>
							)}
						</Show>
						<For each={live().compactions}>
							{(item) => (
								<text fg={color("textMuted")}>
									Native compaction #{String(item.taskId)} ·{" "}
									{String(item.reason)} · attempt {String(item.attempt)}
									{item.retry ? ` · retry ${JSON.stringify(item.retry)}` : ""}
								</text>
							)}
						</For>
						<Show when={live().compactionFailure}>
							{(failure) => (
								<text fg={color("warning")}>
									Native compaction failure · {String(failure().error)}
								</text>
							)}
						</Show>
					</>
				)}
			</Show>

			<Show when={props.selected && !selected()}>
				<text fg={color("warning")}>
					Saved card is not in the currently observed transcript (clipped
					history or ended/disconnected live activity). Selection is not
					replaced automatically; choose an observed card explicitly.
				</text>
			</Show>
			<Show when={window()?.truncated}>
				<text fg={color("warning")}>
					{props.freezeWindow
						? "Showing a frozen bounded native-entry window."
						: "Showing the newest 200 native entries."}{" "}
					Unpaired tool activity is unknown outside this history window.
				</text>
			</Show>
			<For each={messageSlots()}>
				{(messageSlot) => {
					const message = messageSlot.value;
					const messageTrack = anchor(
						JSON.stringify(["reading-message", message().identity]),
					);
					onCleanup(() => messageTrack(null));
					const contentParts = createMemo(() => parts(message()));
					const partSlots = createKeyedItems(
						contentParts,
						({ part, identity }) => JSON.stringify([identity, part.type]),
					);
					const firstText = () =>
						contentParts().find(
							({ part }) =>
								part.type === "text" &&
								typeof part.text === "string" &&
								part.text.length > 0,
						)?.identity;
					return (
						<>
							<Show
								when={
									text(message()) &&
									message().role !== "toolResult" &&
									message().role !== "assistant"
								}
							>
								<Show
									when={message().role === "user"}
									fallback={
										<box
											ref={messageTrack}
											flexDirection="column"
											paddingLeft={3}
											paddingRight={1}
											flexShrink={0}
										>
											<Show when={message().role !== "assistant"}>
												<text fg={color("textMuted")}>
													{String(message().role)}
												</text>
											</Show>
											<Show when={message().nativePartial === true}>
												<text fg={color("textMuted")}>
													Native in-flight committed partial
												</text>
											</Show>
											<MarkdownViewer
												content={text(message())}
												fg={color("text")}
												streaming={message().nativePartial === true}
											/>
										</box>
									}
								>
									<UserPrompt
										anchor={messageTrack}
										text={text(message())}
										timestamp={message().timestamp}
										expanded={props.expanded.includes(
											String(message().identity),
										)}
										onToggle={() => props.toggle(String(message().identity))}
									/>
								</Show>
							</Show>
							<For each={message().role === "assistant" ? partSlots() : []}>
								{(partSlot) => {
									const part = () => partSlot.value().part;
									const prose = () => {
										const value = part().text;
										return typeof value === "string" ? value : "";
									};
									const thinking = () => {
										const value = part().thinking;
										return typeof value === "string" ? value : "";
									};
									const identity = partSlot.value().identity;
									const track = anchor(identity);
									onCleanup(() => track(null));
									return (
										<Switch
											fallback={
												<text fg={color("textMuted")}>
													Unsupported native assistant content part ·{" "}
													{String(part().type ?? "type unavailable")} — not
													interpreted.
												</text>
											}
										>
											<Match when={part().type === "text"}>
												<Show when={prose().length > 0}>
													<box
														ref={track}
														flexDirection="column"
														paddingLeft={3}
														paddingRight={1}
														flexShrink={0}
													>
														<Show
															when={
																message().nativePartial === true &&
																identity === firstText()
															}
														>
															<text fg={color("textMuted")}>
																Native in-flight committed partial
															</text>
														</Show>
														<AssistantMarkdown
															transcript={(key, text) =>
																markdownCache.parts(key, text)
															}
															partKey={identity}
															text={prose()}
															fg={color("text")}
															live={message().nativePartial === true}
														/>
													</box>
												</Show>
											</Match>
											<Match when={part().type === "thinking"}>
												<box
													flexDirection="column"
													paddingLeft={3}
													paddingRight={1}
													flexShrink={0}
												>
													<TranscriptHeader
														identity={identity}
														select={props.select}
														toggle={props.toggle}
														anchor={track}
													>
														<box flexDirection="row">
															<Show when={message().nativePartial === true}>
																<Spinner
																	color={color("textMuted")}
																	attributes={TextAttributes.DIM}
																/>
																<text fg={color("textMuted")}> </text>
															</Show>
															<text
																flexGrow={1}
																minWidth={0}
																fg={
																	message().nativePartial === true
																		? color("textMuted")
																		: color("warning")
																}
																attributes={
																	message().nativePartial === true
																		? TextAttributes.DIM
																		: undefined
																}
															>
																{props.selected === identity ? "› " : ""}
																{props.expanded.includes(identity) ? "▾" : "▸"}{" "}
																{message().nativePartial === true
																	? "Thinking… · committed partial"
																	: "Thinking… · retained"}
															</text>
															<Stamp timestamp={message().timestamp} />
														</box>
													</TranscriptHeader>
													<Show when={props.expanded.includes(identity)}>
														<text
															fg={color("textMuted")}
															attributes={
																TextAttributes.ITALIC |
																(message().nativePartial === true
																	? TextAttributes.DIM
																	: 0)
															}
														>
															{thinking()}
														</text>
													</Show>
												</box>
											</Match>
											<Match when={part().type === "toolCall"}>
												<ToolCard
													identity={identity}
													selected={props.selected === identity}
													select={props.select}
													anchor={track}
													call={part()}
													partial={message().nativePartial === true}
													progress={liveLinks().linked.get(identity)}
													result={
														associations().links.get(identity)?.result ?? null
													}
													pairing={
														associations().links.get(identity)?.pairing ??
														"missing"
													}
													expanded={props.expanded}
													toggle={props.toggle}
													syntax={syntax}
												/>
											</Match>
											<Match when={part().type === "image"}>
												<ImageView
													content={part().data}
													mediaType={part().mimeType}
													caption={
														message().nativePartial === true
															? "Native committed partial image — not retained completion evidence"
															: "Retained native transcript image"
													}
												/>
											</Match>
										</Switch>
									);
								}}
							</For>
							<Show
								when={
									message().role === "toolResult" &&
									!associations().consumed.has(String(message().identity))
								}
							>
								<box
									flexDirection="column"
									border={["left"]}
									borderColor={
										message().isError === true
											? color("error")
											: color("border")
									}
									paddingLeft={1}
								>
									<text fg={color("warning")}>
										Unpaired retained result ·{" "}
										{String(message().toolName ?? "tool")} ·{" "}
										{String(message().toolCallId ?? "identity unavailable")} —
										no unique call in this window.
									</text>
									<text wrapMode="word">
										{text(message()) || "No text output retained."}
									</text>
									<Show when={message().details !== undefined}>
										<code
											content={JSON.stringify(message().details, null, 2)}
											filetype="json"
											syntaxStyle={syntax}
											drawUnstyledText={true}
											wrapMode="word"
										/>
									</Show>
								</box>
							</Show>
							<For
								each={dataList(message().content).filter(
									(part) =>
										part.type === "image" &&
										message().role !== "assistant" &&
										(message().role !== "toolResult" ||
											!associations().consumed.has(String(message().identity))),
								)}
							>
								{(part) => (
									<ImageView
										content={part.data}
										mediaType={part.mimeType}
										caption="Retained native transcript image"
									/>
								)}
							</For>
						</>
					);
				}}
			</For>
			<For each={standalone()}>
				{(row) => (
					<ToolCard
						identity={row.identity}
						selected={props.selected === row.identity}
						select={props.select}
						anchor={anchor(row.identity)}
						call={{
							id: row.slot.callId,
							name: row.slot.name,
							arguments: row.slot.arguments,
						}}
						progress={row.slot}
						liveOnly={true}
						result={null}
						pairing="missing"
						expanded={props.expanded}
						toggle={props.toggle}
						syntax={syntax}
					/>
				)}
			</For>
			<Show when={!messages().length}>
				<text fg={color("textMuted")}>No retained transcript entries.</text>
			</Show>
		</box>
	);
}
