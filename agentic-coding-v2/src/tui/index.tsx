/** @jsxImportSource @opentui/solid */
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { ClientConnection } from "./client/connection.ts";
import {
	applyTheme,
	loadCustomThemes,
	loadThemeName,
} from "./features/environments/preferences.ts";
import { App } from "./shell/App.tsx";

/** The view a window reproduces: a location, never a command or a draft. */
export interface WindowRoute {
	page: string;
	resource: string | null;
}

export type WindowResult =
	| { ok: true; name: string }
	| { ok: false; reason: string };

/**
 * Open one view in a new tmux window that *attaches* to this host instead of
 * starting a second one: v1's Ctrl+T. The credential travels in the child's
 * environment, never on its command line, so it does not appear in `ps`.
 */
export async function openViewWindow(
	endpoint: { url: string; token: string },
	route: WindowRoute,
): Promise<WindowResult> {
	if (!process.env.TMUX || !Bun.which("tmux"))
		return {
			ok: false,
			reason: "tmux is not available; run the shell inside a tmux client",
		};
	const name = `acv2-${route.page}${route.resource ? "-view" : ""}`.slice(
		0,
		40,
	);
	const child = Bun.spawn(
		[
			"tmux",
			"new-window",
			"-n",
			name,
			"-c",
			process.cwd(),
			"--",
			process.execPath,
			Bun.main,
			"--attach-url",
			endpoint.url,
			"--route",
			JSON.stringify(route),
		],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				AGENTIC_CODING_V2_ATTACH_TOKEN: endpoint.token,
			},
		},
	);
	const stderr = await new Response(child.stderr).text();
	const code = await child.exited;
	if (code !== 0)
		return {
			ok: false,
			reason: (stderr.trim() || `tmux new-window failed (${code})`).slice(
				0,
				200,
			),
		};
	return { ok: true, name };
}

/** Terminal lifecycle only; backend authority stays behind the client gateway. */
export async function runTui(
	endpoint: { url: string; token: string },
	options: { route?: WindowRoute } = {},
) {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("--tui requires an interactive terminal");
	loadCustomThemes();
	applyTheme(loadThemeName());
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
					<App
						client={client}
						quit={quit}
						{...(options.route ? { initialRoute: options.route } : {})}
						openWindow={(route) => openViewWindow(endpoint, route)}
					/>
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
