/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { TelemetryReceiverState } from "../../../telemetry/contracts.ts";
import type { ClientConnection } from "../../client/connection.ts";
import {
	Form,
	GenericModal,
	type KeybindSection,
	uiColors,
} from "../../ui/index.ts";
import { HomeView } from "../home/HomeView.tsx";

type Operation = "start" | "stop" | "prune" | "scan" | "watch" | "unwatch";

/** v1 list/form/modal controls, attached to native operator boundaries. No
 * prompt prefill or token rendering; a credential is displayed by reference. */
export function TelemetryControls(props: {
	client: ClientConnection;
	active: () => boolean;
	back: () => void;
	catalog: (sections: KeybindSection[]) => void;
	notify: (message: string) => void;
}) {
	const [selected, select] = createSignal(0);
	const [operation, setOperation] = createSignal<Operation>();
	const [value, setValue] = createSignal("");
	const [choice, setChoice] = createSignal(0);
	const [confirm, setConfirm] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [receiver, setReceiver] = createSignal<TelemetryReceiverState>();
	let disposed = false;
	const ready = () => !disposed && props.client.stateFresh && !busy();
	const repositories = () => props.client.state?.repositories ?? [];
	const report = (error: unknown) =>
		props.notify(
			error instanceof Error ? error.message : "Telemetry control refused",
		);
	const reload = async () => {
		if (!ready()) return;
		setBusy(true);
		try {
			const state = await props.client.call("telemetry.receiver.read", {});
			if (!disposed) setReceiver(state);
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	onMount(() => {
		void reload();
	});
	const open = (id: string) => {
		if (!ready()) return;
		const action = id as Operation;
		setOperation(action);
		setConfirm(false);
		setChoice(0);
		setValue(
			action === "start"
				? "4317"
				: action === "prune"
					? "30"
					: (repositories()[0] ?? ""),
		);
		if (action === "stop") setConfirm(true);
	};
	const cancel = () => {
		setConfirm(false);
		setOperation(undefined);
	};
	const execute = async () => {
		const action = operation();
		if (!action || !ready()) return;
		setBusy(true);
		try {
			if (action === "start" || action === "stop") {
				const basis = receiver();
				if (!basis) throw new Error("Reload receiver state first");
				if (
					action === "start" &&
					(!/^\d+$/.test(value()) || Number(value()) > 65535)
				)
					throw new Error("Port must be 0–65535 (0 chooses a free port)");
				const state =
					action === "start"
						? await props.client.call("telemetry.receiver.start", {
								revision: basis.revision,
								port: Number(value()),
							})
						: await props.client.call("telemetry.receiver.stop", {
								revision: basis.revision,
							});
				if (!disposed) setReceiver(state);
			} else if (action === "prune") {
				if (
					!/^\d+$/.test(value()) ||
					Number(value()) < 1 ||
					Number(value()) > 3650
				)
					throw new Error("Retention must be 1–3650 days");
				await props.client.call("telemetry.manage", {
					operation: "prune",
					days: Number(value()),
				});
			} else {
				if (!repositories().includes(value()))
					throw new Error("Choose an authorized repository");
				await props.client.call("telemetry.manage", {
					operation: action,
					repository: value(),
				});
			}
			if (!disposed) {
				cancel();
				props.notify("Telemetry control applied");
			}
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const isRepository = () =>
		["scan", "watch", "unwatch"].includes(operation() ?? "");
	const unregister = useKeymap().registerLayer({
		id: "v2.telemetry.controls",
		priority: 90,
		enabled: props.active,
		commands: [
			{
				name: "telemetry.controls.key",
				run: ({ event }) => {
					if (event.ctrl || event.meta || event.option) return false;
					const key = event.name.toLowerCase();
					if (busy()) return true;
					if (confirm()) {
						if (key === "escape" || key === "n") setConfirm(false);
						else if (key === "return" || key === "enter" || key === "y")
							void execute();
						else return false;
						return true;
					}
					if (key === "escape") {
						if (operation()) cancel();
						else props.back();
						return true;
					}
					if (!operation()) {
						if (key === "r") {
							void reload();
							return true;
						}
						return false;
					}
					if (key === "return" || key === "enter") {
						if (operation() === "prune" || operation() === "stop")
							setConfirm(true);
						else void execute();
						return true;
					}
					if (isRepository()) {
						if (key === "j" || key === "down")
							setChoice((index) =>
								Math.min(Math.max(0, repositories().length - 1), index + 1),
							);
						else if (key === "k" || key === "up")
							setChoice((index) => Math.max(0, index - 1));
						else if (key === "space") setValue(repositories()[choice()] ?? "");
						else return false;
					} else if (key === "backspace") setValue((text) => text.slice(0, -1));
					else if (event.sequence && /^\d$/.test(event.sequence))
						setValue((text) => (text + event.sequence).slice(0, 5));
					else return false;
					return true;
				},
			},
		],
		bindings: [
			"escape",
			"return",
			"enter",
			"r",
			"y",
			"n",
			"j",
			"k",
			"up",
			"down",
			"space",
			"backspace",
			..."0123456789",
		].map((key) => ({ key, cmd: "telemetry.controls.key" })),
	});
	createEffect(() => {
		if (!operation()) return;
		props.catalog([
			{
				title: "Telemetry controls",
				keybinds: confirm()
					? [
							{ key: "y/Enter", action: "Confirm operation", short: "confirm" },
							{ key: "Esc/n", action: "Cancel confirmation", standard: true },
						]
					: [
							{ key: "Enter", action: "Apply control", short: "apply" },
							{ key: "Space", action: "Select repository", short: "select" },
							{ key: "Esc", action: "Back", standard: true },
						],
			},
		]);
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		props.catalog([]);
	});
	return (
		<box flexDirection="column" flexGrow={1}>
			<text fg={uiColors.textMuted}>
				OTLP gRPC traces · {receiver()?.status ?? "unavailable"} · revision{" "}
				{receiver()?.revision ?? "?"}
			</text>
			<Show when={receiver()?.address}>
				<text wrapMode="word">Address: {receiver()?.address}</text>
			</Show>
			<Show when={receiver()?.credentialFile}>
				<text wrapMode="word">
					Bearer credential file: {receiver()?.credentialFile}
				</text>
			</Show>
			<Show when={busy()}>
				<text>Applying telemetry control…</text>
			</Show>
			<Show when={!operation()}>
				<HomeView
					title="Telemetry controls"
					destinations={[
						{
							id: "start",
							label: "Start gRPC receiver",
							description:
								"Loopback-only OTLP TraceService; explicit port and private credential reference",
						},
						{
							id: "stop",
							label: "Stop gRPC receiver",
							description: "Join in-flight exports and revoke the credential",
						},
						{
							id: "prune",
							label: "Prune telemetry",
							description:
								"Remove telemetry older than the selected retention period",
						},
						{
							id: "scan",
							label: "Scan workspace telemetry",
							description: "Read existing files in an authorized repository",
						},
						{
							id: "watch",
							label: "Watch workspace telemetry",
							description: "Register one watcher per authorized repository",
						},
						{
							id: "unwatch",
							label: "Stop watching workspace",
							description: "Release the selected repository watcher",
						},
					]}
					active={() => props.active() && !busy()}
					open={open}
					selected={selected()}
					select={select}
					catalog={props.catalog}
				/>
			</Show>
			<Show when={operation()}>
				<Show when={operation() !== "stop"}>
					<Form
						fields={[
							isRepository()
								? {
										key: "value",
										label: "Repository",
										kind: "select",
										options: repositories(),
									}
								: {
										key: "value",
										label:
											operation() === "start"
												? "Port (0 = automatic)"
												: "Retain days",
										kind: "text",
									},
						]}
						values={{ value: value() }}
						activeIndex={0}
						focusedPane="value"
						choiceCursorIndex={choice()}
						editing={!isRepository()}
					/>
				</Show>
			</Show>
			<Show when={confirm()}>
				<GenericModal
					title={
						operation() === "prune" ? "Prune telemetry?" : "Stop receiver?"
					}
					help={[
						{ key: "Enter", action: "Confirm" },
						{ key: "Esc", action: "Cancel" },
					]}
					helpSections={false}
					onHelpKeybindActivate={(binding) => {
						if (binding.key === "Enter") void execute();
						else setConfirm(false);
					}}
				>
					<text fg={uiColors.warning}>
						{operation() === "prune"
							? `Remove telemetry older than ${value()} days. This cannot be undone.`
							: "Stop this receiver and revoke its credential. Exporters must be reconfigured after restart."}
					</text>
				</GenericModal>
			</Show>
		</box>
	);
}
