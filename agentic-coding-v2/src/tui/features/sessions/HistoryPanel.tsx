/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader as NativeActionHeader } from "../../ui/ActionHeader.tsx";
import type { LocalChoice } from "../../ui/LocalChoice.ts";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";
/** Explicit native history reads and local exploration, never live-watch merging,
 * prompt restoration, context adoption, execution or implicit older-page reads. */
export function HistoryPanel(props: {
	client: ClientConnection;
	id: number;
	connected: boolean;
	scope: object;
	interactive: boolean;
	choose: (choice: LocalChoice) => void;
}) {
	const [entries, setEntries] = createSignal<Data[]>([]),
		[cursor, setCursor] = createSignal<string | null>(null),
		[loaded, setLoaded] = createSignal(false),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal<string | null>(null),
		[open, setOpen] = createSignal(false),
		[kind, setKind] = createSignal<string | null>(null),
		[start, setStart] = createSignal(0),
		[selected, setSelected] = createSignal<number | null>(null);
	let epoch = 0,
		disposed = false;
	const source = createMemo(
		() => ({
			client: props.client,
			id: props.id,
			connected: props.connected,
			scope: props.scope,
		}),
		undefined,
		{
			equals: (a, b) =>
				a.client === b.client &&
				a.id === b.id &&
				a.connected === b.connected &&
				a.scope === b.scope,
		},
	);
	const clear = () => {
		epoch++;
		setEntries([]);
		setCursor(null);
		setLoaded(false);
		setPending(false);
		setError(null);
		setKind(null);
		setStart(0);
		setSelected(null);
	};
	createEffect(() => {
		source();
		clear();
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
	});
	const matching = createMemo(() =>
		entries().filter((entry) => kind() === null || entry.kind === kind()),
	);
	const offset = () => Math.min(start(), Math.max(0, matching().length - 1));
	const visible = () => matching().slice(offset(), offset() + 20);
	const controls = createMemo(() => [
		source(),
		entries(),
		kind(),
		start(),
		selected(),
		pending(),
		props.interactive,
	]);
	const ActionHeader = (action: {
		onActivate: () => void;
		children: JSX.Element;
	}) => (
		<NativeActionHeader
			scope={controls()}
			interactive={props.interactive && !pending()}
			onActivate={action.onActivate}
		>
			{action.children}
		</NativeActionHeader>
	);
	const load = async (older = false) => {
		if (
			disposed ||
			!props.interactive ||
			pending() ||
			!props.connected ||
			(older && !cursor())
		)
			return;
		const generation = epoch,
			id = props.id,
			client = props.client,
			scope = props.scope,
			continuation = older ? cursor() : null;
		const current = () =>
			!disposed &&
			generation === epoch &&
			props.id === id &&
			props.client === client &&
			props.scope === scope &&
			props.connected;
		// A continuation can be consumed even if the reply is lost. Never retry it
		// automatically or retain it as an apparently reusable local reference.
		setCursor(null);
		setPending(true);
		setError(null);
		try {
			const page = await client.call("session.history", {
				id,
				...(continuation ? { cursor: continuation } : {}),
			});
			if (!current()) return;
			if (page.id !== id)
				throw new Error(
					"Wrong native history response identity; page not adopted",
				);
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
			if (continuation && page.cursor === continuation)
				throw new Error("Repeated native history cursor; page not adopted");
			const combined = continuation
				? [...page.entries, ...entries()]
				: page.entries;
			const retained = new Map<number, Data>();
			for (const entry of combined) {
				const prior = retained.get(Number(entry.id));
				if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
					throw new Error(
						"Conflicting retained history identity; page not adopted",
					);
				if (!prior) retained.set(Number(entry.id), entry);
			}
			const next = [...retained.values()].slice(0, 500);
			setEntries(next);
			setCursor(page.cursor);
			setLoaded(true);
			setOpen(true);
			const filtered = next.filter(
				(entry) => kind() === null || entry.kind === kind(),
			);
			setStart(continuation ? 0 : Math.max(0, filtered.length - 20));
		} catch (cause) {
			if (current())
				setError(
					`${cause instanceof Error ? cause.message : "History read refused"}. Continuation withdrawn locally; explicitly refresh newest for a new scan. No automatic retry.`,
				);
		} finally {
			if (current()) setPending(false);
		}
	};
	const chooseLocal = (
		title: string,
		rows: { key: string; label: string; detail?: string }[],
		initialKey: string | undefined,
		apply: (key: string) => void,
	) => {
		if (!props.interactive || pending() || disposed) return;
		const captured = entries(),
			scope = props.scope,
			version = epoch,
			selectedKind = kind();
		const valid = () =>
			!disposed &&
			epoch === version &&
			props.scope === scope &&
			entries() === captured &&
			kind() === selectedKind &&
			!pending();
		props.choose({
			title,
			rows,
			initialKey,
			note: "Search loaded native entries only · no older-page read, live context adoption or execution",
			valid,
			choose: (key) => {
				if (!valid() || !rows.some((row) => row.key === key)) return false;
				apply(key);
				return true;
			},
		});
	};
	const chooseKind = () =>
		chooseLocal(
			"Choose supplied retained entry kind",
			[
				{ key: "all", label: "All retained kinds" },
				...[...new Set(entries().map((entry) => String(entry.kind)))].map(
					(value) => ({ key: `kind:${value}`, label: value }),
				),
			],
			kind() === null ? "all" : `kind:${kind()}`,
			(key) => {
				setKind(key === "all" ? null : key.slice(5));
				setStart(0);
			},
		);
	const find = () =>
		chooseLocal(
			"Find a loaded native history entry",
			matching().map((entry) => ({
				key: String(entry.id),
				label: `Entry #${String(entry.id)} · ${String(entry.kind)}`,
				detail: JSON.stringify(entry.data ?? {}).slice(0, 160),
			})),
			selected() === null ? undefined : String(selected()),
			(key) => {
				const index = matching().findIndex((entry) => String(entry.id) === key);
				if (index >= 0) {
					setSelected(Number(key));
					setStart(Math.floor(index / 20) * 20);
				}
			},
		);
	return (
		<box flexDirection="column" border={true} padding={1} gap={1}>
			<ActionHeader
				onActivate={() => {
					if (props.interactive && !pending()) setOpen((value) => !value);
				}}
			>
				<text fg={color("accent")}>
					{open() ? "▾" : "▸"} Retained native history explorer ·{" "}
					{entries().length} loaded
				</text>
			</ActionHeader>
			<Show when={open()}>
				<text fg={color("textMuted")} wrapMode="word">
					Explicit read-only native pages; at most 500 entries held locally and
					20 mounted at once. Native fork/context/head metadata remains
					uninterpreted. Search, kind filtering and local windows perform no
					backend read. Older scans drop newest cached entries; reconnect clears
					cursor state and never replays.
				</text>
				<Show when={props.connected && !pending()}>
					<ActionHeader onActivate={() => void load()}>
						<text fg={color("accent")}>
							{loaded()
								? "Explicitly refresh newest retained page"
								: "Read newest retained page"}
						</text>
					</ActionHeader>
				</Show>
				<Show when={entries().length > 0}>
					<ActionHeader onActivate={find}>
						<text fg={color("accent")}>Search loaded native entries</text>
					</ActionHeader>
					<ActionHeader onActivate={chooseKind}>
						<text fg={color("accent")}>
							Choose retained kind · {kind() ?? "all"}
						</text>
					</ActionHeader>
					<text fg={color("textMuted")}>
						Local rows {matching().length ? offset() + 1 : 0}–
						{Math.min(offset() + 20, matching().length)} / {matching().length}{" "}
						matching · selected native entry {selected() ?? "none"}
					</text>
					<Show
						when={
							selected() !== null &&
							!entries().some((entry) => entry.id === selected())
						}
					>
						<text fg={color("warning")}>
							Selected entry left the local retention window; no replacement is
							adopted.
						</text>
					</Show>
					<Show when={offset() > 0}>
						<ActionHeader
							onActivate={() => {
								if (props.interactive) setStart(Math.max(0, offset() - 20));
							}}
						>
							<text fg={color("accent")}>
								Previous local history window (no native read)
							</text>
						</ActionHeader>
					</Show>
					<For each={visible()}>
						{(entry) => (
							<StructuredData
								value={entry}
								label={`Entry #${String(entry.id)} · ${String(entry.kind)}${entry.id === selected() ? " · selected" : ""}`}
							/>
						)}
					</For>
					<Show when={offset() + 20 < matching().length}>
						<ActionHeader
							onActivate={() => {
								if (props.interactive) setStart(offset() + 20);
							}}
						>
							<text fg={color("accent")}>
								Next local history window (no native read)
							</text>
						</ActionHeader>
					</Show>
					<ActionHeader
						onActivate={() => {
							if (props.interactive && !pending()) clear();
						}}
					>
						<text fg={color("accent")}>
							Clear local history cache (no native deletion)
						</text>
					</ActionHeader>
				</Show>
				<Show when={props.connected && !pending() && cursor()}>
					<ActionHeader onActivate={() => void load(true)}>
						<text fg={color("accent")}>Read next older native page</text>
					</ActionHeader>
				</Show>
				<Show when={loaded() && !cursor() && !pending() && !error()}>
					<text fg={color("textMuted")}>
						Native scan reached its end at this observation.
					</text>
				</Show>
				<Show when={entries().length >= 500}>
					<text fg={color("warning")}>
						Local retention is full. Older paging continues while dropping newer
						cached entries; refresh newest explicitly to return.
					</text>
				</Show>
				<Show when={pending()}>
					<text fg={color("textMuted")}>Native history read pending</text>
				</Show>
				<Show when={error()}>
					<text fg={color("error")} wrapMode="word">
						{error()}
					</text>
				</Show>
			</Show>
		</box>
	);
}
