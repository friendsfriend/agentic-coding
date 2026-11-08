/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { HelpModal } from "../presentation/components/HelpModal.tsx";
import type { KeybindSection } from "../presentation/components/keybinds.ts";
import { bindings, type Keybind } from "../ui/keybinds.ts";

export const helpOverlayKeybinds: Keybind[] = [
	{ key: "j", cmd: "help.next", action: "Scroll help down", standard: true },
	{ key: "down", cmd: "help.next", action: "Scroll help down", standard: true },
	{ key: "k", cmd: "help.previous", action: "Scroll help up", standard: true },
	{ key: "up", cmd: "help.previous", action: "Scroll help up", standard: true },
	{
		key: "pagedown",
		cmd: "help.pageNext",
		action: "Next help page",
		standard: true,
	},
	{
		key: "pageup",
		cmd: "help.pagePrevious",
		action: "Previous help page",
		standard: true,
	},
	{ key: "home", cmd: "help.first", action: "First help row", standard: true },
	{ key: "end", cmd: "help.last", action: "Last help page", standard: true },
	{ key: "escape", cmd: "help.close", action: "Close help", short: "close" },
	{ key: "f1", cmd: "help.close", action: "Close help", standard: true },
	{ key: "?", cmd: "help.close", action: "Close help", standard: true },
];

/** Native read-only modal layer. No gateway, draft, approval or route mutation. */
export function HelpOverlay(props: {
	sections: KeybindSection[];
	close: () => void;
}) {
	const keymap = useKeymap();
	const [offset, setOffset] = createSignal(0);
	const [lines, setLines] = createSignal(1);
	const [rows, setRows] = createSignal(0);
	let disposed = false;
	const maximum = () => Math.max(0, rows() - lines());
	const clamp = (value: number) => Math.max(0, Math.min(maximum(), value));
	createEffect(() => setOffset((value) => clamp(value)));
	const move = (amount: number) => setOffset((value) => clamp(value + amount));
	// Disposing a modal unregisters keymap resources. Defer dismissal until the
	// current dispatch completes, as required by the native keymap contract.
	const close = () =>
		queueMicrotask(() => {
			if (!disposed) props.close();
		});
	keymap.clearPendingSequence();
	const unregister = keymap.registerLayer({
		id: "v2.help-overlay",
		priority: 100,
		commands: [
			{ id: "help.next", name: "Scroll help down", run: () => move(1) },
			{ id: "help.previous", name: "Scroll help up", run: () => move(-1) },
			{ id: "help.pageNext", name: "Next help page", run: () => move(lines()) },
			{
				id: "help.pagePrevious",
				name: "Previous help page",
				run: () => move(-lines()),
			},
			{ id: "help.first", name: "First help row", run: () => setOffset(0) },
			{
				id: "help.last",
				name: "Last help page",
				run: () => setOffset(maximum()),
			},
			{ id: "help.close", name: "Close help", run: close },
		],
		bindings: bindings(helpOverlayKeybinds),
	});
	const allowed = helpOverlayKeybinds.map((binding) =>
		keymap.createKeyMatcher(binding.key),
	);
	const release = keymap.intercept(
		"key",
		(context) => {
			if (!allowed.some((match) => match(context.event)))
				context.consume({ preventDefault: true, stopPropagation: true });
		},
		{ priority: 100 },
	);
	onCleanup(() => {
		disposed = true;
		release();
		unregister();
	});
	return (
		<HelpModal
			title="Keybindings"
			sections={props.sections}
			offset={offset()}
			onOffset={(value) => setOffset(clamp(value))}
			onLines={setLines}
			onRows={setRows}
			close={close}
		/>
	);
}
