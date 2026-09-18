/** @jsxImportSource @opentui/solid */
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { ErrorDialog } from "./ErrorDialog";
import { activeErrorModal, dismissErrorModal } from "./errorModal";

/**
 * Global error-modal overlay. Rendered once by the shell so an error raised by
 * any surface (dashboard detail, workspace overview, wiki, changed files) is
 * shown above every tab, not just the surface that produced it. Owns the
 * `modal.active = "error"` keymap handoff and j/k scrolling; Esc/Enter
 * dismissal is owned by the shell's key handler so the dismissal key is
 * consumed exactly once and never drives the tab underneath. Surfaces only
 * call `showErrorModal`.
 */
export function ErrorModalOverlay(props: {
	keymap?: Keymap<Renderable, KeyEvent>;
}) {
	let scrollBox: { scrollBy(dy: number): void } | undefined;
	let previousModal: string | undefined;

	// Park the active surface's keymap on the error modal while it is open and
	// restore the modal that owned the keys before it. Surfaces include the
	// global error modal in their "any modal open" self-heal so this value is
	// never reset out from under us.
	createEffect(() => {
		const keymap = props.keymap;
		if (!keymap) return;
		if (activeErrorModal()) {
			if (previousModal === undefined) {
				const current = keymap.getData?.("modal.active");
				previousModal = typeof current === "string" ? current : "none";
			}
			if (keymap.getData?.("modal.active") !== "error")
				keymap.setData("modal.active", "error");
			return;
		}
		if (previousModal !== undefined) {
			const restore = previousModal === "error" ? "none" : previousModal;
			previousModal = undefined;
			keymap.setData("modal.active", restore);
		}
	});

	onMount(() => {
		const keymap = props.keymap;
		if (!keymap) return;
		const dispose = keymap.registerLayer({
			name: "error-modal",
			priority: 1200,
			activeModal: "error",
			commands: [
				{
					name: "error-modal.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (key === "j" || key === "down") {
							scrollBox?.scrollBy(1);
							return true;
						}
						if (key === "k" || key === "up") {
							scrollBox?.scrollBy(-1);
							return true;
						}
						return true;
					},
				},
			],
			bindings: ["j", "k", "up", "down"].map((key) => ({
				key,
				cmd: "error-modal.handle",
			})),
		});
		onCleanup(dispose);
	});

	return (
		<Show when={activeErrorModal()} keyed>
			{(item) => (
				<ErrorDialog
					title={item.title}
					message={item.message}
					showHelp={false}
					zIndex={40}
					onClose={() => dismissErrorModal()}
					onScrollBoxReady={(ref) => {
						scrollBox = ref;
					}}
				/>
			)}
		</Show>
	);
}
