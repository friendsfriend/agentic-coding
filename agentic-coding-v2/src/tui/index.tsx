/** @jsxImportSource @opentui/solid */
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { ClientConnection } from "./client/connection.ts";
import { App } from "./shell/App.tsx";

/** Terminal lifecycle only; backend authority stays behind the client gateway. */
export async function runTui(endpoint: { url: string; token: string }) {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("--tui requires an interactive terminal");
	const client = new ClientConnection(endpoint);
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		exitSignals: [],
	});
	const done = new Promise<void>((resolve) =>
		renderer.once(CliRenderEvents.DESTROY, resolve),
	);
	const quit = () => renderer.destroy();
	process.once("SIGINT", quit);
	process.once("SIGTERM", quit);
	try {
		if (renderer.isDestroyed) return;
		const keymap = createDefaultOpenTuiKeymap(renderer);
		client.connect();
		await render(
			() => (
				<KeymapProvider keymap={keymap}>
					<App client={client} quit={quit} />
				</KeymapProvider>
			),
			renderer,
		);
		await done;
	} finally {
		process.removeListener("SIGINT", quit);
		process.removeListener("SIGTERM", quit);
		client.close();
		renderer.destroy();
		await renderer.closed;
	}
}
