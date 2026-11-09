/** @jsxImportSource @opentui/solid */
import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	untrack,
	useContext,
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
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { ImageView } from "../../ui/ImageView.tsx";
import { bindings, transcriptKeybinds } from "../../ui/keybinds.ts";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";
import { NativeProgress } from "./NativeProgress.tsx";
import { ResponseFooter } from "./ResponseFooter.tsx";
import { SessionMarkdownCache } from "./session-markdown-cache.ts";
import type { PromptTimelineRow } from "./TimelinePicker.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { ToolContentParts } from "./ToolContentParts.tsx";
import { TranscriptHeader } from "./TranscriptHeader.tsx";
import { TranscriptRowsContext } from "./TranscriptRows.ts";

/** Local mounted-entry paging, extended by explicit native history pages the
 * reader asks for. A page is an observation appended above the retained window,
 * never a continuation of it and never a replacement watch. */
export type LocalTranscriptPaging = {
	token: () => object | null;
	hasOlder: () => boolean;
	loadOlder: () => boolean;
	expandAll: () => boolean;
	collapse: () => void;
};

type Link = {
	result: Data | null;
	pairing: "matched" | "missing" | "ambiguous";
};
export function Transcript(props: {
	value: TranscriptData | null;
	observation: "none" | "resynchronizing" | "watching" | "unavailable";
	observationError: string | null;
	/** Supplies an explicit history read for this conversation only. */
	history?: {
		client: {
			call: (
				method: "session.history",
				input: { id: number; cursor?: string },
			) => Promise<{ id: number; entries: Data[]; cursor: string | null }>;
		};
		id: number;
		connected: boolean;
	} | null;
	enabled: boolean;
	interactive: boolean;
	scope: object;
	onReadIntent: () => void;
	selected: string | null;
	freezeWindow?: boolean;
	registerLocalPaging?: (paging: LocalTranscriptPaging) => () => void;
	select: (id: string) => void;
	reveal: (node: BoxRenderable, key: string) => void;
	registerReadingRows?: (
		rows: ReadonlyMap<string, BoxRenderable>,
	) => () => void;
	onPromptTimeline?: (
		rows: ReadonlyMap<string, BoxRenderable>,
		items: PromptTimelineRow[],
	) => void;
	expanded: string[];
	toggle: (id: string) => void;
}) {
	const keymap = useKeymap(),
		choices = useContext(LocalChoiceContext);
	let disposed = false;
	const anchors = new Map<string, BoxRenderable>();
	onMount(() => {
		const unregister = props.registerReadingRows?.(anchors);
		if (unregister) onCleanup(unregister);
		const unregisterPaging = props.registerLocalPaging?.(localPaging);
		if (unregisterPaging) onCleanup(unregisterPaging);
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
	onCleanup(() => {
		disposed = true;
		anchors.clear();
		retainedCache.clear();
	});
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
	// Match the original 60/40 window/page cadence using supplied native entries.
	// Pairing below still sees the complete bounded retained window.
	const [localWindow, setLocalWindow] = createSignal<{
		id: number;
		count: number;
	} | null>(null);
	const mountCount = () =>
		localWindow()?.id === window()?.id ? (localWindow()?.count ?? 60) : 60;
	const localStart = () =>
		Math.max(0, (window()?.entries.length ?? 0) - mountCount());
	createEffect(() => {
		if (localWindow()?.id !== window()?.id) setLocalWindow(null);
	});
	const expandLocal = (all: boolean) => {
		const value = window();
		const start = localStart();
		if (!value || start <= 0 || (!all && !props.freezeWindow)) return false;
		setLocalWindow({
			id: value.id,
			count: all ? 200 : Math.min(200, mountCount() + 40),
		});
		return true;
	};
	// Explicitly requested native history pages. Identity, scope and connection
	// are captured before the await; a late reply can never adopt another owner.
	const [history, setHistory] = createSignal<{
		key: string;
		entries: Data[];
		cursor: string | null;
	}>({ key: "", entries: [], cursor: null });
	const [historyPending, setHistoryPending] = createSignal(false);
	const [historyError, setHistoryError] = createSignal<string | null>(null);
	let historyEpoch = 0;
	const historyKey = () => (props.history ? String(props.history.id) : "");
	const historyEntries = () =>
		history().key === historyKey() ? history().entries : [];
	const historyCursor = () =>
		history().key === historyKey() ? history().cursor : null;
	createEffect(() => {
		historyKey();
		historyEpoch++;
		setHistory({ key: historyKey(), entries: [], cursor: null });
		setHistoryError(null);
		setHistoryPending(false);
	});
	const loadHistory = async () => {
		const source = props.history;
		if (!source?.connected || historyPending() || disposed) return false;
		const epoch = ++historyEpoch,
			everything = historyKey(),
			cursor = historyCursor();
		const current = () =>
			!disposed &&
			epoch === historyEpoch &&
			historyKey() === everything &&
			props.history?.connected === true;
		setHistoryPending(true);
		setHistoryError(null);
		try {
			const page = await source.client.call("session.history", {
				id: source.id,
				...(cursor === null ? {} : { cursor }),
			});
			if (!current()) return false;
			if (page.id !== source.id)
				throw new Error("Wrong native history identity; page not adopted");
			const seen = new Set<number>();
			for (const entry of page.entries) {
				if (
					!Number.isSafeInteger(entry.id) ||
					Number(entry.id) < 1 ||
					seen.has(Number(entry.id))
				)
					throw new Error(
						"Duplicate or invalid native history identity; page not adopted",
					);
				seen.add(Number(entry.id));
			}
			if (cursor !== null && page.cursor === cursor)
				throw new Error("Repeated native history cursor; page not adopted");
			const merged = new Map<number, Data>();
			for (const entry of [...historyEntries(), ...page.entries]) {
				const id = Number(entry.id),
					prior = merged.get(id);
				if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
					throw new Error(
						"Conflicting retained history identity; page not adopted",
					);
				if (!prior) merged.set(id, entry);
			}
			const ordered = [...merged.values()]
				.sort((left, right) => Number(left.id) - Number(right.id))
				.slice(-400);
			setHistory({ key: everything, entries: ordered, cursor: page.cursor });
			return true;
		} catch (cause) {
			if (current())
				setHistoryError(
					`${cause instanceof Error ? cause.message : "History read refused"}. No automatic retry; explicitly request the newest page again.`,
				);
			return false;
		} finally {
			if (current()) setHistoryPending(false);
		}
	};
	const localPaging: LocalTranscriptPaging = {
		token: window,
		hasOlder: () => localStart() > 0 || historyCursor() !== null,
		loadOlder: () => {
			if (expandLocal(false)) return true;
			if (historyCursor() !== null && !historyPending()) {
				void loadHistory();
				return true;
			}
			return false;
		},
		expandAll: () => expandLocal(true),
		collapse: () => setLocalWindow(null),
	};
	// The reading window, plus any explicitly requested history pages above it.
	// History entries keep their native identities; nothing is renumbered, and the
	// two sources are never claimed to be contiguous.
	const readingEntries = createMemo<Data[]>(() => {
		const retained = window()?.entries ?? [];
		const older = historyEntries();
		if (older.length === 0) return retained;
		const boundary = Number(retained[0]?.id ?? Number.POSITIVE_INFINITY);
		return [
			...older.filter((entry) => Number(entry.id) < boundary),
			...retained,
		];
	});
	const mergedOlder = createMemo(
		() => readingEntries().length - (window()?.entries.length ?? 0),
	);
	const visibleEntries = createMemo(
		() =>
			new Set<unknown>(
				readingEntries()
					.slice(localStart() + mergedOlder())
					.map((entry) => entry.id),
			),
	);
	const messages = createMemo<Data[]>(() => {
		const nextCache = new Map<string, { signature: string; value: Data }>();
		const retained = readingEntries().flatMap((entry) =>
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
						nativeTaskId: live.run.taskId,
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
			ownerTaskId: message.nativeTaskId,
		}));
	// Retained byte changes replace their row. Only a live generation with the
	// same native task/attempt identity updates its mounted presentation carrier.
	const visibleMessages = createMemo(() =>
		messages().filter(
			(message) =>
				message.nativePartial === true ||
				visibleEntries().has(message.nativeEntryId),
		),
	);
	const messageSlots = createKeyedItems(visibleMessages, (message) =>
		message.nativePartial === true
			? JSON.stringify([message.identity, "live"])
			: (retainedRenderKeys.get(message) ?? JSON.stringify(message)),
	);
	const markdownCache = new SessionMarkdownCache();
	createEffect(() => {
		markdownCache.retain(
			new Set(
				visibleMessages()
					.filter((message) => message.role === "assistant")
					.flatMap(parts)
					.filter(({ part }) => part.type === "text")
					.map(({ identity }) => identity),
			),
		);
	});
	onCleanup(() => markdownCache.clear());
	const visibleCallIdentities = createMemo(
		() =>
			new Set(
				visibleMessages()
					.filter(
						(message) =>
							message.role === "assistant" && message.nativePartial !== true,
					)
					.flatMap(parts)
					.filter(({ part }) => part.type === "toolCall")
					.map(({ identity }) => identity),
			),
	);
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
				if (visibleCallIdentities().has(match.identity)) consumed.add(slot);
			}
		}
		return { linked, consumed };
	});
	const standalone = createMemo(() => {
		const rows = [
			...(progress()?.tools ?? []).filter(
				(slot) => !liveLinks().consumed.has(slot),
			),
			...(progress()?.nestedTools ?? []),
		].map((slot) => ({
			slot,
			ownerTaskId: progress()?.run?.taskId,
			identity: JSON.stringify([
				"native-live-tool",
				props.value?.id,
				progress()?.run?.taskId ?? null,
				slot.taskId ?? null,
				slot.entry ?? null,
				slot.callId,
				slot.name,
				slot.parentTaskId ?? null,
				slot.parentCallId ?? null,
			]),
			part: { type: "liveTool" } as Data,
		}));
		const counts = new Map<string, number>();
		for (const row of rows)
			counts.set(row.identity, (counts.get(row.identity) ?? 0) + 1);
		return rows.map((row, index) => {
			const ambiguous = counts.get(row.identity) !== 1;
			return {
				...row,
				ambiguous,
				identity: ambiguous
					? JSON.stringify(["ambiguous-native-slot", row.identity, index])
					: row.identity,
			};
		});
	});
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
			if (matched && visibleCallIdentities().has(identity))
				consumed.add(String(matched.identity));
		}
		return { links, consumed };
	});
	const controls = createMemo(() => [
		...visibleMessages()
			.filter((message) => message.role === "assistant")
			.flatMap(parts)
			.filter(
				({ part }) => part.type === "toolCall" || part.type === "thinking",
			),
		...standalone().filter((row) => !row.ambiguous),
	]);
	const enabled = createMemo(() => props.enabled);
	const selected = () =>
		controls().find((item) => item.identity === props.selected);
	const active = () => !disposed && props.interactive;
	const selectCard = (
		identity: string,
		confirmedChoice = false,
		revealSelection = true,
	) => {
		if (
			disposed ||
			(!confirmedChoice && !active()) ||
			!controls().some((row) => row.identity === identity)
		)
			return;
		props.select(identity);
		const node = anchors.get(identity);
		if (revealSelection && node && !node.isDestroyed)
			props.reveal(node, identity);
	};
	const toggleCard = (identity: string, revealSelection = true) => {
		const base = controls().find(
			(row) =>
				identity === row.identity ||
				[":arguments", ":output", ":details"].some(
					(suffix) => identity === `${row.identity}${suffix}`,
				),
		);
		if (!active() || !base) return;
		props.toggle(identity);
		const node = anchors.get(base.identity);
		if (revealSelection && node && !node.isDestroyed)
			props.reveal(node, base.identity);
	};
	const move = (direction: number) => {
		if (!enabled() || !active()) return;
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
		selectCard(next.identity);
	};
	const slotFor = (identity: string) =>
		liveLinks().linked.get(identity) ??
		standalone().find((row) => row.identity === identity)?.slot;
	const parentOf = (identity: string) => {
		const child = slotFor(identity);
		if (
			!child ||
			child.parentTaskId === undefined ||
			child.parentCallId === undefined ||
			child.parentCallId.length === 0
		)
			return undefined;
		const candidates = controls().filter((row) => {
			if (
				row.identity === identity ||
				!["toolCall", "liveTool"].includes(String(row.part.type))
			)
				return false;
			const slot = slotFor(row.identity);
			return (
				(row.part.id === child.parentCallId ||
					slot?.callId === child.parentCallId) &&
				(row.ownerTaskId === child.parentTaskId ||
					slot?.taskId === child.parentTaskId)
			);
		});
		return candidates.length === 1 ? candidates[0] : undefined;
	};
	const chooseCards = (
		title = "Choose an observed thinking/tool card",
		subset = controls(),
	) => {
		if (!active() || !choices || subset.length === 0) return;
		const scope = props.scope,
			id = props.value?.id,
			captured = controls();
		const valid = () =>
			!disposed &&
			props.scope === scope &&
			props.value?.id === id &&
			controls() === captured;
		choices.choose({
			title,
			rows: subset.map((row) => ({
				key: row.identity,
				label:
					row.part.type === "thinking"
						? "Observed thinking"
						: String(
								row.part.name ?? slotFor(row.identity)?.name ?? "Native tool",
							),
				detail: row.identity,
			})),
			initialKey: props.selected ?? undefined,
			note: "Mounted supplied cards only · no task/context adoption, history read, expansion inference or execution",
			valid,
			choose: (key) => {
				if (!valid() || !subset.some((row) => row.identity === key))
					return false;
				selectCard(key, true);
				return true;
			},
		});
	};
	const moveParent = () => {
		if (!enabled() || !active()) return;
		const parent = props.selected ? parentOf(props.selected) : undefined;
		if (parent) selectCard(parent.identity);
	};
	const moveChild = () => {
		if (!enabled() || !active() || !props.selected) return;
		const children = controls().filter(
			(row) => parentOf(row.identity)?.identity === props.selected,
		);
		if (children.length === 1 && children[0]) selectCard(children[0].identity);
		else if (children.length > 1)
			chooseCards("Choose a uniquely linked observed child card", children);
	};
	const toggleSection = (suffix: string) => {
		if (!enabled() || !active()) return;
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
		if (!props.expanded.includes(row.identity)) toggleCard(row.identity);
		toggleCard(`${row.identity}${suffix}`);
	};
	createEffect(() => {
		if (!enabled()) return;
		const unregister = untrack(() =>
			keymap.registerLayer({
				id: "v2.transcript",
				priority: 30,
				commands: [
					{
						id: "transcript.choose",
						name: "Choose a mounted observed card",
						run: () => {
							if (enabled()) chooseCards();
						},
					},
					{
						id: "transcript.parent",
						name: "Select a uniquely supplied parent card",
						run: moveParent,
					},
					{
						id: "transcript.child",
						name: "Select a uniquely supplied child card",
						run: moveChild,
					},
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
							if (enabled() && row) toggleCard(row.identity);
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
					...(typeof message.timestamp === "number" &&
					Number.isFinite(message.timestamp) &&
					message.timestamp >= 0 &&
					Number.isFinite(new Date(message.timestamp).getTime())
						? { timestamp: message.timestamp }
						: {}),
					key: JSON.stringify(["reading-message", message.identity]),
					label: Array.from(text(message).replace(/\s+/g, " ").trim())
						.slice(0, 512)
						.join(""),
				})),
		);
	});
	return (
		<TranscriptRowsContext.Provider
			value={{
				selectable: (key) =>
					active() && controls().some((row) => row.identity === key),
				activate: (key, suffix = "") => {
					// Pointer folds preserve the current reading anchor. Keyboard and
					// explicit chooser navigation use post-layout reveal separately.
					if (!active()) return;
					props.onReadIntent();
					selectCard(key, false, false);
					toggleCard(`${key}${suffix}`, false);
				},
				register: (key, node) => {
					anchors.set(key, node);
					return () => {
						if (anchors.get(key) === node) anchors.delete(key);
					};
				},
				reveal: (key, node) => {
					if (!disposed && anchors.get(key) === node) props.reveal(node, key);
				},
			}}
		>
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
						<NativeProgress
							value={live()}
							scope={props.scope}
							interactive={active()}
						/>
					)}
				</Show>

				<Show when={controls().length > 0}>
					<ActionHeader
						scope={[props.scope, controls()]}
						interactive={props.interactive}
						onActivate={() => chooseCards()}
					>
						<text fg={color("accent")}>
							Choose observed thinking/tool card (local navigation)
						</text>
					</ActionHeader>
				</Show>
				<Show when={standalone().some((row) => row.ambiguous)}>
					<text fg={color("warning")} wrapMode="word">
						Repeated native slot identities remain read-only observations; no
						selected card or parent/child target is inferred from their order.
					</text>
				</Show>
				<Show
					when={
						selected() &&
						slotFor(props.selected ?? "")?.parentTaskId !== undefined
					}
				>
					<text fg={color("textMuted")} wrapMode="word">
						Nested navigation follows both supplied parent task and call
						pointers only. Missing, clipped or ambiguous parents are not
						adopted; Ctrl+Alt+Left/Right navigates uniquely linked mounted
						cards.
					</text>
				</Show>
				<Show when={props.selected && !selected()}>
					<text fg={color("warning")}>
						Saved card is not mounted in the currently observed transcript
						(local or clipped history or ended/disconnected live activity).
						Selection is not replaced automatically; choose an observed card
						explicitly.
					</text>
				</Show>
				<Show when={window()?.truncated}>
					<text fg={color("warning")}>
						{props.freezeWindow
							? "Showing a frozen bounded native-entry window."
							: "Retaining the newest 200 native entries for this bounded view."}{" "}
						Unpaired tool activity is unknown outside this history window.
					</text>
				</Show>
				<Show when={localStart() > 0}>
					<text fg={color("textMuted")} wrapMode="word">
						{localStart()} older supplied native entries are not mounted. Scroll
						upward to expand this local window first; a native history read
						happens only after the retained window is exhausted.
					</text>
				</Show>
				<Show when={historyEntries().length > 0}>
					<text fg={color("textMuted")} wrapMode="word">
						{`${historyEntries().length} older native history ${
							historyEntries().length === 1 ? "entry" : "entries"
						} read explicitly and shown above the retained window. `}
						They are a separate read: identities are native and never
						renumbered, a gap between the page and the retained window is
						possible, and they are not a continuation of the live watch, another
						conversation's adoption, or authority to resume anything.
					</text>
				</Show>
				<Show when={historyPending()}>
					<text fg={color("textMuted")}>
						Reading one older native history page…
					</text>
				</Show>
				<Show when={historyError()}>
					{(message) => (
						<text fg={color("warning")} wrapMode="word">
							{message()}
						</text>
					)}
				</Show>
				<For each={messageSlots()}>
					{(messageSlot) => {
						const message = messageSlot.value;
						const messageTrack = anchor(
							JSON.stringify(["reading-message", message().identity]),
						);
						onCleanup(() => messageTrack(null));
						const contentParts = createMemo(() => parts(message()));
						const rawParts = createMemo(() => dataList(message().content));
						const messageObservation = createMemo(() => ({
							scope: props.scope,
							message: message(),
						}));
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
											onToggle={() => {
												if (active()) {
													props.onReadIntent();
													props.toggle(String(message().identity));
												}
											}}
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
													<box ref={track} flexDirection="column" gap={1}>
														<text fg={color("textMuted")}>
															Unsupported supplied assistant part — not
															interpreted or executed.
														</text>
														<SuppliedObservation
															interactive={active()}
															value={part()}
															scope={messageObservation()}
															label="Complete supplied unsupported part fields; serialized JSON, not authority"
														/>
													</box>
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
																	{props.expanded.includes(identity)
																		? "▾"
																		: "▸"}{" "}
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
														scope={messageObservation()}
														interactive={active()}
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
								<Show when={message().role === "assistant"}>
									<ResponseFooter
										message={message()}
										scope={messageObservation()}
										interactive={active()}
									/>
								</Show>
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
											no unique mounted call in this local window.
										</text>
										<ToolContentParts
											interactive={active()}
											parts={rawParts()}
											scope={messageObservation()}
										/>
										<SuppliedObservation
											interactive={active()}
											value={message()}
											scope={messageObservation()}
											label="Complete supplied unpaired presentation carrier; serialization includes UI identity, never a native target or inferred pairing"
										/>
									</box>
								</Show>
								<Show
									when={
										message().role !== "assistant" &&
										(message().role !== "toolResult" ||
											!associations().consumed.has(String(message().identity)))
									}
								>
									<ToolContentParts
										interactive={active()}
										parts={rawParts()}
										scope={messageObservation()}
										imagesOnly
									/>
								</Show>
							</>
						);
					}}
				</For>
				<For each={standalone()}>
					{(row) => (
						<ToolCard
							scope={props.scope}
							interactive={active()}
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
		</TranscriptRowsContext.Provider>
	);
}
