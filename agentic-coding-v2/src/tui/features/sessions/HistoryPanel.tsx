/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";
/** Explicit retained history paging, independent of the current live watch.
 * Opening/folding older entries cannot execute tools or restore a prompt. */
export function HistoryPanel(props: {
	client: ClientConnection;
	id: number;
	connected: boolean;
}) {
	const [entries, setEntries] = createSignal<Data[]>([]),
		[cursor, setCursor] = createSignal<string | null>(null),
		[loaded, setLoaded] = createSignal(false),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal<string | null>(null),
		[open, setOpen] = createSignal(false);
	let epoch = 0,
		disposed = false;
	createEffect(() => {
		props.id;
		props.connected;
		epoch++;
		setEntries([]);
		setCursor(null);
		setLoaded(false);
		setError(null);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
	});
	const load = async (older = false) => {
		if (pending() || !props.connected || (older && !cursor())) return;
		const generation = epoch,
			id = props.id;
		setPending(true);
		setError(null);
		try {
			const page = await props.client.call("session.history", {
				id,
				...(older && cursor() ? { cursor: cursor() ?? undefined } : {}),
			});
			if (!disposed && generation === epoch && page.id === id) {
				const combined = older ? [...page.entries, ...entries()] : page.entries;
				const seen = new Set<unknown>();
				setEntries(
					combined
						.filter((entry) => {
							if (seen.has(entry.id)) return false;
							seen.add(entry.id);
							return true;
						})
						.slice(0, 500),
				);
				setCursor(page.cursor);
				setLoaded(true);
				setOpen(true);
			}
		} catch (cause) {
			if (!disposed && generation === epoch)
				setError(
					cause instanceof Error ? cause.message : "History read refused",
				);
		} finally {
			if (!disposed) setPending(false);
		}
	};
	return (
		<box flexDirection="column" border={true} padding={1} gap={1}>
			<ActionHeader onActivate={() => setOpen((value) => !value)}>
				<text fg={color("accent")}>
					{open() ? "▾" : "▸"} Retained native history explorer ·{" "}
					{entries().length} loaded
				</text>
			</ActionHeader>
			<Show when={open()}>
				<text fg={color("textMuted")} wrapMode="word">
					Explicit read-only pages, newest window first, then older entries in
					chronological order. Native fork/context/head metadata is retained,
					not interpreted as execution authority. At most 500 entries held
					locally; older paging drops newest cached entries and retires the used
					cursor, without stopping the scan. Reconnect clears cursor state,
					never replays. Large records use bounded expandable presentation.
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
				<For each={entries()}>
					{(entry) => (
						<StructuredData
							value={entry}
							label={`Entry #${String(entry.id)} · ${String(entry.kind)}`}
						/>
					)}
				</For>
				<Show when={props.connected && !pending() && cursor()}>
					<ActionHeader onActivate={() => void load(true)}>
						<text fg={color("accent")}>Read next older native page</text>
					</ActionHeader>
				</Show>
				<Show when={loaded() && !cursor()}>
					<text fg={color("textMuted")}>
						Native scan reached its end at this observation.
					</text>
				</Show>
				<Show when={entries().length >= 500}>
					<text fg={color("warning")}>
						Local retention window is full. Paging continues older while
						dropping newer cached entries; refresh newest explicitly to return.
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
