/** @jsxImportSource @opentui/solid */
// The shared profile/preset editor as a Settings surface
// (centralize-application-settings, task 2.1). Ownership of the editor moved
// out of the workflow dashboard home: Settings registers the modal layer and
// mounts the same `ModelConfigModal`, so there is one editor and one writer
// instead of a second form. Harness model discovery, reference validation,
// built-in defaults, fusion routing and the registered verifier role catalog
// all come from that component, unchanged.
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createSignal, onCleanup, onMount } from "solid-js";
import { ModelConfigModal } from "../dash/ui/ModelConfigModal";

/** Keys the editor dialog owns while it is open. */
const MODAL_KEYS = [
	"escape",
	"return",
	"enter",
	"backspace",
	"delete",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"j",
	"k",
	"d",
	"u",
	"/",
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*() "
		.split("")
		.map((key) => (key === " " ? "space" : key)),
];

export function SettingsAgentEditor(props: {
	keymap: Keymap<Renderable, KeyEvent>;
	/** Project scope; absent means the user configuration. */
	repository?: string;
	onClose: () => void;
}) {
	const [handler, setHandler] = createSignal<(event: KeyEvent) => boolean>();
	onMount(() => {
		const dispose = props.keymap.registerLayer({
			name: "settings-model-config",
			priority: 1000,
			activeModal: "model-config",
			commands: [
				{
					name: "settings-model-config.handle",
					run: ({ event }) => handler()?.(event) ?? true,
				},
			],
			bindings: MODAL_KEYS.map((key) => ({
				key,
				cmd: "settings-model-config.handle",
				preventDefault: false,
			})),
		});
		props.keymap.setData("modal.active", "model-config");
		onCleanup(() => {
			dispose();
			props.keymap.setData("modal.active", "none");
		});
	});
	return (
		<ModelConfigModal
			{...(props.repository ? { repository: props.repository } : {})}
			onKeyReady={(next) => setHandler(() => next)}
			onCancel={() => props.onClose()}
		/>
	);
}
