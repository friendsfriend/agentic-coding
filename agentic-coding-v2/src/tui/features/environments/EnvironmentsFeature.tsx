/** @jsxImportSource @opentui/solid */
// The restored v1 environments page, mounted inside the v2 shell.
//
// This is v1's `EnvironmentsFeature` (src/tui/app/EnvironmentsFeature.tsx)
// ported onto the v2 gateway: the original devenv TUI body runs in embedded
// mode on the shell's renderer and keymap, and its client facade talks to the
// authenticated native gateway through `GatewayBackend`. Only the data source
// differs; views, keys, modals and styling are the original.
import { useKeymap } from "@opentui/keymap/solid";
import { createEffect, onCleanup } from "solid-js";
import type { ClientConnection } from "../../client/connection.ts";
import { publishHostChrome } from "../../ui/index.ts";
import { TUIApp } from "./app/app-opentui.tsx";
import { setupDevenvKeymap } from "./app/keyboard/keymap-setup.ts";
import { GatewayBackend } from "./gateway-backend.ts";

/** Rows the v2 shell draws around a page body: header, breadcrumb, footer. */
const SHELL_CHROME_LINES = 5;
const SHELL_FEATURE_FIELD = Symbol("v2:devenv-shell-feature");

export function EnvironmentsFeature(props: {
	client: ClientConnection;
	active: () => boolean;
	onModalChange?: (open: boolean) => void;
	/** The environment's live footer/help catalog (v1 `onKeybindCatalog`). */
	onKeybindCatalog?: (
		sections: Array<{
			title: string;
			keybinds: Array<{ key: string; action: string }>;
		}>,
	) => void;
}) {
	const keymap = useKeymap();
	// v1's embedded layers declare `shellFeature`; the v2 shell names the
	// feature that owns the body so a hidden page never receives keys.
	const disposeFields = keymap.acquireResource(SHELL_FEATURE_FIELD, () =>
		keymap.registerLayerFields({
			shellFeature(value, ctx) {
				ctx.require("shell.feature", String(value));
			},
		}),
	);
	const disposeKeymap = setupDevenvKeymap(keymap, true);
	createEffect(() => {
		keymap.setData("shell.feature", props.active() ? "environments" : "none");
	});
	createEffect(() => {
		publishHostChrome({
			lines: SHELL_CHROME_LINES,
			namesPage: true,
			gaps: true,
		});
		onCleanup(() => publishHostChrome(undefined));
	});
	onCleanup(() => {
		keymap.setData("shell.feature", "none");
		disposeKeymap();
		disposeFields();
	});
	return (
		<TUIApp
			serverUrl="agentic-coding-v2://gateway"
			backend={(showError) => new GatewayBackend(props.client, showError)}
			embedded
			chromeLines={SHELL_CHROME_LINES}
			active={props.active}
			{...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
			{...(props.onKeybindCatalog
				? { onKeybindCatalog: props.onKeybindCatalog }
				: {})}
		/>
	);
}
