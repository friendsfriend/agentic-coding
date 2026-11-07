/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createSignal,
	type JSX,
	onCleanup,
	untrack,
} from "solid-js";
import { type ActionAnchor, ActionRegistry } from "./ActionHeader.tsx";
import { actionKeybinds, bindings } from "./keybinds.ts";
/** Keyboard parity for rendered read/navigation/preparation controls. No backend methods here. */
export function ActionScope(props: {
	enabled: boolean;
	reveal: (node: BoxRenderable) => void;
	children: JSX.Element;
}) {
	const keymap = useKeymap(),
		anchors = new Map<string, ActionAnchor>(),
		[selected, setSelected] = createSignal<string | null>(null);
	const available = () =>
		[...anchors.values()]
			.filter((anchor) => {
				const node = anchor.node();
				return node && !node.isDestroyed && node.visible && node.height > 0;
			})
			.sort(
				(a, b) =>
					(a.node()?.y ?? 0) - (b.node()?.y ?? 0) ||
					(a.node()?.x ?? 0) - (b.node()?.x ?? 0),
			);
	const choose = (direction: number) => {
		const rows = available();
		if (!rows.length) return;
		const index = rows.findIndex((row) => row.id === selected()),
			next =
				rows[
					index < 0
						? direction > 0
							? 0
							: rows.length - 1
						: Math.max(0, Math.min(rows.length - 1, index + direction))
				];
		if (!next) return;
		setSelected(next.id);
		const node = next.node();
		if (node) props.reveal(node);
	};
	createEffect(() => {
		if (!props.enabled) {
			setSelected(null);
			return;
		}
		const unregister = untrack(() =>
			keymap.registerLayer({
				id: "v2.ui-controls",
				priority: 25,
				commands: [
					{
						id: "controls.next",
						name: "Select next rendered UI control",
						run: () => choose(1),
					},
					{
						id: "controls.previous",
						name: "Select previous rendered UI control",
						run: () => choose(-1),
					},
					{
						id: "controls.activate",
						name: "Activate selected UI control (commands remain unsent)",
						run: () => {
							const anchor = available().find(
								(anchor) => anchor.id === selected(),
							);
							anchor?.activate();
						},
					},
				],
				bindings: bindings(actionKeybinds),
			}),
		);
		onCleanup(unregister);
	});
	return (
		<ActionRegistry.Provider
			value={{
				selected,
				select: setSelected,
				register: (anchor) => {
					anchors.set(anchor.id, anchor);
					return () => {
						anchors.delete(anchor.id);
						if (selected() === anchor.id) setSelected(null);
					};
				},
			}}
		>
			{props.children}
		</ActionRegistry.Provider>
	);
}
