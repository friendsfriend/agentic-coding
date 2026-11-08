/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import type {
	StandaloneInventory,
	StandaloneMode,
} from "../../../protocol/standalone.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { color } from "../../ui/theme/index.ts";
import { StandaloneSessionRow } from "./StandaloneSessionRow.tsx";
import { StandaloneTranscript } from "./StandaloneTranscript.tsx";
/** Separate native identity space. No durable IDs, backend discovery or implicit adoption. */
export function StandalonePanel(props: {
	client: ClientConnection;
	mode: StandaloneMode;
	resource: string | null;
	connected: boolean;
	refresh: number;
	scope: object;
	interactive: boolean;
	filter: string;
	sort: "default" | "newest";
	select: (id: string) => void;
	observe: (value: StandaloneInventory) => void;
	onFresh: (fresh: boolean) => void;
}) {
	const [inventory, setInventory] = createSignal<StandaloneInventory | null>(
			null,
		),
		[error, setError] = createSignal<string | null>(null),
		[fresh, setFresh] = createSignal(false);
	const publishFresh = (value: boolean) => {
		setFresh(value);
		props.onFresh(value);
	};
	let epoch = 0,
		pending = false,
		queued = false,
		disposed = false;
	const read = async () => {
		if (!props.connected || disposed) return;
		if (pending) {
			queued = true;
			return;
		}
		const generation = epoch,
			client = props.client,
			mode = props.mode,
			selected = props.resource;
		pending = true;
		try {
			const value = await client.observeStandalone({ mode, id: selected });
			if (
				generation !== epoch ||
				disposed ||
				!props.connected ||
				props.client !== client
			)
				return;
			setInventory(value);
			props.observe(value);
			publishFresh(true);
			setError(null);
		} catch (cause) {
			if (generation === epoch && !disposed) {
				publishFresh(false);
				setError(
					cause instanceof Error ? cause.message : "Standalone unavailable",
				);
			}
		} finally {
			pending = false;
			if (queued && !disposed) {
				queued = false;
				queueMicrotask(() => void read());
			}
		}
	};
	const request = createMemo(
		() => ({
			client: props.client,
			mode: props.mode,
			resource: props.resource,
			connected: props.connected,
			refresh: props.refresh,
			scope: props.scope,
		}),
		undefined,
		{
			equals: (left, right) =>
				left.client === right.client &&
				left.mode === right.mode &&
				left.resource === right.resource &&
				left.connected === right.connected &&
				left.refresh === right.refresh &&
				left.scope === right.scope,
		},
	);
	createEffect(() => {
		const target = request();
		epoch++;
		publishFresh(false);
		setError(
			target.connected
				? "Refreshing native standalone observation…"
				: "Disconnected; retained display is cached and current activity unknown",
		);
		untrack(() => void read());
	});
	const timer = setInterval(() => void read(), 2000);
	onCleanup(() => {
		disposed = true;
		epoch++;
		publishFresh(false);
		clearInterval(timer);
	});
	const sessions = createMemo(() => {
		let rows =
			inventory()?.sessions.filter((session) => session.mode === props.mode) ??
			[];
		if (props.filter)
			rows = rows.filter((session) =>
				[
					session.title,
					session.id,
					session.repository,
					session.profile,
					session.status,
				]
					.join("\n")
					.toLowerCase()
					.includes(props.filter.toLowerCase()),
			);
		return props.sort === "newest" ? [...rows].reverse() : rows;
	});
	const selected = createMemo(() => {
		const matches =
			inventory()?.sessions.filter(
				(session) =>
					session.id === props.resource && session.mode === props.mode,
			) ?? [];
		return matches.length === 1 ? matches[0] : undefined;
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				{props.mode === "pi" ? "Pi · native SDK" : "OpenCode · native service"}{" "}
				· independent standalone conversations
			</text>
			<Show
				when={
					inventory() &&
					!(props.mode === "pi"
						? inventory()?.piAvailable
						: inventory()?.opencodeAvailable)
				}
			>
				<text wrapMode="word" fg={color("warning")}>
					{props.mode === "pi"
						? "Installed native ModelRuntime is required; no provider or credential discovery fallback."
						: "Set AGENTIC_CODING_V2_OPENCODE_URL before a separately authorized host start. Optional token: AGENTIC_CODING_V2_OPENCODE_TOKEN. No URL/token values, automatic server start or legacy bridge."}
				</text>
			</Show>
			<For each={sessions().map((session) => session.id)}>
				{(id, index) => (
					<Show when={sessions().find((session) => session.id === id)}>
						{(session) => (
							<StandaloneSessionRow
								position={index()}
								layout={JSON.stringify([props.filter, props.sort])}
								session={session()}
								selected={props.resource === id}
								fresh={fresh()}
								interactive={props.interactive}
								scope={props.scope}
								open={() => {
									if (
										props.interactive &&
										sessions().some(
											(entry) => entry.id === id && entry.mode === props.mode,
										)
									)
										props.select(id);
								}}
							/>
						)}
					</Show>
				)}
			</For>
			<Show when={inventory() && sessions().length === 0}>
				<text fg={color("textMuted")}>
					No standalone sessions match this mode/filter. No session is selected
					automatically.
				</text>
			</Show>
			<Show when={selected()}>
				{(session) => (
					<box flexDirection="column" gap={1}>
						<text fg={color("textMuted")} wrapMode="word">
							{session().id}@{session().revision} · configured profile:{" "}
							{session().profile}
						</text>
						<text fg={color("textMuted")} wrapMode="word">
							Repository: {session().repository} ·{" "}
							{session().truncated
								? "retained display window clipped"
								: "retained display window"}
							. No task/environment execution authority or lifetime usage
							estimate.
						</text>
						<StandaloneTranscript
							mode={props.mode}
							sessionId={session().id}
							messages={session().messages}
							partial={session().partial}
							busy={fresh() && session().status === "busy"}
							interactive={props.interactive}
							scope={props.scope}
						/>
					</box>
				)}
			</Show>
			<Show when={props.resource !== null && inventory() && !selected()}>
				<text fg={color("warning")}>
					Saved standalone identity is unavailable in this mode. Its draft stays
					unsent; choose another UUID explicitly.
				</text>
			</Show>
			<Show when={error()}>
				<text wrapMode="word" fg={color("warning")}>
					{error()}
				</text>
			</Show>
			<text wrapMode="word" fg={color("textMuted")}>
				{inventory()?.scope ??
					"Reading native capabilities; no backend launch, discovery or resource adoption."}
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Bounded, non-atomic observation. Busy is native attempt activity, not
				completion; uncertain attempts are never redispatched. Manage sessions
				through explicit shared-prompt commands.
			</text>
		</box>
	);
}
