/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type {
	StandaloneInventory,
	StandaloneMode,
} from "../../../protocol/standalone.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";
/** A separate native identity space. No durable IDs, lease adoption or private backend URLs. */
export function StandalonePanel(props: {
	client: ClientConnection;
	mode: StandaloneMode;
	resource: string | null;
	connected: boolean;
	refresh: number;
	select: (id: string) => void;
	observe: (value: StandaloneInventory) => void;
}) {
	const [inventory, setInventory] = createSignal<StandaloneInventory | null>(
			null,
		),
		[error, setError] = createSignal<string | null>(null);
	let epoch = 0,
		pending = false,
		disposed = false;
	const read = async () => {
		if (!props.connected || pending || disposed) return;
		const generation = epoch,
			mode = props.mode,
			selected = props.resource;
		pending = true;
		try {
			const listing = await props.client.call("standalone.read", {});
			if (generation !== epoch || disposed || !props.connected) return;
			const detail = selected
				? await props.client.call("standalone.read", { id: selected })
				: null;
			if (generation !== epoch || disposed || !props.connected) return;
			if (
				detail &&
				!detail.sessions.some(
					(session) => session.id === selected && session.mode === mode,
				)
			)
				throw new Error(
					"Saved standalone identity belongs to another mode or is unavailable",
				);
			const value = {
				...listing,
				sessions: listing.sessions.map(
					(session) =>
						detail?.sessions.find((item) => item.id === session.id) ?? session,
				),
			};
			setInventory(value);
			props.observe(value);
			setError(null);
		} catch (error) {
			if (generation === epoch && !disposed)
				setError(
					error instanceof Error ? error.message : "Standalone unavailable",
				);
		} finally {
			pending = false;
		}
	};
	createEffect(() => {
		props.mode;
		props.resource;
		props.connected;
		props.refresh;
		epoch++;
		setError(
			props.connected
				? "Refreshing native standalone observation…"
				: "Disconnected; retained display is cached and current activity unknown",
		);
		void read();
	});
	const timer = setInterval(() => void read(), 2000);
	onCleanup(() => {
		disposed = true;
		epoch++;
		clearInterval(timer);
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				{props.mode === "pi" ? "Native Pi SDK" : "Native OpenCode service"} ·
				independent standalone conversations
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				{inventory()?.scope ??
					"Reading native capabilities; no automatic backend launch, discovery or resource adoption."}
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
						: "Set AGENTIC_CODING_V2_OPENCODE_URL before a separately authorized host start. Optional token is AGENTIC_CODING_V2_OPENCODE_TOKEN; values/URLs never enter this view. No automatic server start or legacy bridge."}
				</text>
			</Show>
			<text wrapMode="word" fg={color("textMuted")}>
				Manage sessions through orchestrator/transcript commands in the shared
				prompt. Observations are bounded, non-atomic and refreshed only while
				this view is mounted. Busy is native attempt activity, not completion;
				uncertain attempts are never redispatched. View clipping is not lifetime
				usage or context completeness.
			</text>
			<For
				each={
					inventory()?.sessions.filter(
						(session) => session.mode === props.mode,
					) ?? []
				}
			>
				{(session) => (
					<box
						flexDirection="column"
						gap={1}
						border={true}
						borderColor={
							props.resource === session.id ? color("accent") : color("border")
						}
						padding={1}
					>
						<ActionHeader onActivate={() => props.select(session.id)}>
							<text fg={color("primary")}>
								{session.title} · {session.status} · {session.id}@
								{session.revision}
							</text>
						</ActionHeader>
						<Show when={props.resource === session.id}>
							<text wrapMode="word" fg={color("textMuted")}>
								Repository: {session.repository} · configured profile:{" "}
								{session.profile} ·{" "}
								{session.truncated
									? "retained display window clipped"
									: "retained display window"}
								. No task/environment execution authority.
							</text>
							<Show
								when={session.partial !== null && session.status === "busy"}
							>
								<text fg={color("warning")}>
									Native in-flight text (volatile, clipped, not retained
									completion evidence)
								</text>
								<text wrapMode="word">{session.partial ?? ""}</text>
							</Show>
							<For each={session.messages}>
								{(message) => (
									<box flexDirection="column">
										<text
											fg={
												message.role === "user"
													? color("accent")
													: color("primary")
											}
										>
											{message.role}
										</text>
										<text wrapMode="word">{message.content}</text>
									</box>
								)}
							</For>
						</Show>
					</box>
				)}
			</For>
			<Show when={error()}>
				<text wrapMode="word" fg={color("warning")}>
					{error()}
				</text>
			</Show>
		</box>
	);
}
