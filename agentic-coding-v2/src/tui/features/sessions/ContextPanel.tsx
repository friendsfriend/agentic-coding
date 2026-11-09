/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import type { SessionContext } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

/** An explicit native read and passive local browsing. No polling, adoption,
 * context editing, token estimation, reset, fork, compaction or submission. */
export function ContextPanel(props: {
	client: ClientConnection;
	id: number;
	connected: boolean;
	scope: object;
	interactive: boolean;
}) {
	const [snapshot, setSnapshot] = createSignal<SessionContext | null>(null);
	const [pending, setPending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [open, setOpen] = createSignal(false);
	let epoch = 0,
		disposed = false;
	const owner = createMemo(
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
	createEffect(() => {
		owner();
		epoch++;
		setSnapshot(null);
		setPending(false);
		setError(null);
		setOpen(false);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
	});
	const source = createMemo(() => ({ owner: owner(), snapshot: snapshot() }));
	// Capture alignment in each immutable display carrier. Local window movement
	// must not temporarily rebind an old entry to the new window's ordinal.
	const aligned = createMemo(() => {
		const value = snapshot();
		return (
			value?.entries.map((entry, index) => ({
				entry,
				contribution: value.contributions[index],
				ordinal: index + 1,
			})) ?? []
		);
	});
	const active = () => !disposed && props.interactive;
	const inspect = async () => {
		if (!active() || pending() || !props.connected) return;
		const saved = owner(),
			generation = ++epoch;
		setPending(true);
		setError(null);
		// A failed refresh must not leave the old context looking freshly inspected.
		setSnapshot(null);
		try {
			const value = await saved.client.call("session.context", {
				id: saved.id,
			});
			if (disposed || generation !== epoch || owner() !== saved) return;
			if (
				value.id !== saved.id ||
				value.entries.length !== value.contributions.length
			)
				throw new Error(
					"Wrong native context identity or alignment; snapshot not adopted",
				);
			setSnapshot(value);
			setOpen(true);
		} catch (failure) {
			if (!disposed && generation === epoch && owner() === saved)
				setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			if (!disposed && generation === epoch && owner() === saved)
				setPending(false);
		}
	};
	return (
		<box flexDirection="column">
			<ActionHeader
				scope={[source(), pending()]}
				interactive={active() && props.connected && !pending()}
				onActivate={() => void inspect()}
			>
				<text fg={color("accent")}>
					{pending() ? "Reading context…" : "Read context"}
				</text>
			</ActionHeader>
			<Show when={error()}>
				{(failure) => (
					<text fg={color("warning")} wrapMode="word">
						{failure()}
					</text>
				)}
			</Show>
			<Show when={snapshot()}>
				{(value) => (
					<>
						<ActionHeader
							scope={[source(), open()]}
							interactive={active()}
							onActivate={() => setOpen(!open())}
						>
							<text fg={color("textMuted")}>
								{open() ? "▾" : "▸"} {value().entries.length} entries ·{" "}
								{value().messages.length} messages
								{value().model?.contextWindow
									? ` · window ${value().model?.contextWindow}`
									: ""}
							</text>
						</ActionHeader>
						<Show when={open()}>
							<text fg={color("textMuted")} wrapMode="word">
								Read-only as inspected. Catalogue window{" "}
								{value().model?.contextWindow ?? "not supplied"} · maximum
								output {value().model?.maxOutput ?? "not supplied"}; these are
								catalogue limits, not measured occupancy.
							</text>
							<SuppliedObservation
								interactive={active()}
								scope={source()}
								label="Model and thinking"
								value={{ model: value().model, thinking: value().thinking }}
							/>
							<SuppliedObservation
								interactive={active()}
								scope={source()}
								label="Context head"
								value={value().head}
							/>
							<SuppliedRecordWindow
								rows={aligned()}
								scope={source()}
								interactive={active()}
								label="active context entries and aligned contributions"
								title={(row) =>
									`Entry ${String(row.entry.id)} · ${String(row.entry.kind)} · contribution ${row.ordinal}`
								}
								search={(row) => JSON.stringify(row)}
							>
								{(row) => (
									<box flexDirection="column">
										<SuppliedObservation
											interactive={active()}
											scope={source()}
											label="Entry"
											value={row.entry}
										/>
										<SuppliedObservation
											interactive={active()}
											scope={source()}
											label="Contribution"
											value={row.contribution}
										/>
									</box>
								)}
							</SuppliedRecordWindow>
							<SuppliedRecordWindow
								rows={value().messages}
								scope={source()}
								interactive={active()}
								label="native derived context messages"
								title={(row, index) => `${index + 1}. ${String(row.role)}`}
								search={(row) => JSON.stringify(row)}
							>
								{(message) => (
									<SuppliedObservation
										interactive={active()}
										scope={source()}
										label="Derived message"
										value={message}
									/>
								)}
							</SuppliedRecordWindow>
						</Show>
					</>
				)}
			</Show>
		</box>
	);
}
