import { selfExecEntry } from "../../self-exec.ts";

// Side-app launcher (multiplexer removal).
//
// Side apps — the editor opened from a finding, and anything else that needs a
// real terminal — no longer get a multiplexer pane. The one supported
// multiplexer is the user's own tmux: when this process runs inside a tmux
// client, the app opens in a new tmux window. Everywhere else the process is
// spawned locally with the renderer suspended for its lifetime, so the app owns
// the terminal until it exits and the TUI repaints afterwards.
//
// The decision is a pure function of the environment, and the argv builders are
// pure too, so the launch shape is testable without a terminal.
//
// `openViewWindow` reuses the same tmux preference for a second shell view: it
// re-execs this application at the caller's route with `--attach-url`, so the
// spawned window is a client of the running server and never starts a second one.

/** One side app to open. `command` is an executable, never a shell string. */
export interface SideAppRequest {
	command: string;
	args: readonly string[];
	cwd: string;
}

export type SideAppMode = "tmux" | "local";

/** Whether the process is inside a tmux client (`$TMUX` is set by tmux). */
export function tmuxClient(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.TMUX);
}

/**
 * How a side app opens: inside a tmux client with the tmux executable present
 * it becomes a tmux window; otherwise it is spawned locally. A tmux binary
 * without a client session cannot show a window, so it does not count.
 */
export function sideAppMode(
	env: NodeJS.ProcessEnv = process.env,
	hasTmux: boolean = Boolean(Bun.which("tmux")),
): SideAppMode {
	return tmuxClient(env) && hasTmux ? "tmux" : "local";
}

/**
 * The platform's system opener for one file: `open` on macOS, `xdg-open`
 * elsewhere, and `cmd /c start` on Windows. The file is one argument, never a
 * shell string, and `cwd` is the file's own directory so the opener is not tied
 * to whatever the TUI was started in. Pure, so the launch shape is testable per
 * platform.
 */
export function systemOpenerSideApp(
	file: string,
	platform: NodeJS.Platform = process.platform,
): SideAppRequest {
	const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
	const cwd = file.slice(0, Math.max(0, separator)) || ".";
	if (platform === "darwin") return { command: "open", args: [file], cwd };
	if (platform === "win32")
		return { command: "cmd", args: ["/c", "start", "", file], cwd };
	return { command: "xdg-open", args: [file], cwd };
}

/** `tmux new-window` argv for one side app. `-c` pins the working directory so
 * the window does not inherit the pane's cwd. */
export function tmuxSideAppArgs(request: SideAppRequest): string[] {
	return [
		"new-window",
		"-c",
		request.cwd,
		"--",
		request.command,
		...request.args,
	];
}

/** One shell view to open in a new tmux window: the same TUI, positioned at
 * the route the caller is looking at, attached to the running server. */
export interface ViewWindowRequest {
	/** Window name (the route's page label). */
	name: string;
	/** Directory the window opens in. */
	cwd: string;
	/** Repository the spawned shell reads (`--repo`). */
	repository: string;
	/** Serialized route (`--route` JSON): the page, resource and params. */
	routeJson: string;
	/** Base URL of the running server (`--attach-url`); the spawned shell must
	 * attach to it instead of owning a second server. */
	attachUrl: string;
	/** Capability for the running server, when the parent has one. */
	token?: string;
}

export type WindowResult =
	| { ok: true; name: string }
	| { ok: false; reason: string };

/**
 * tmux window names cannot contain the target separator or control
 * characters; everything else is allowed and kept.
 */
export function tmuxWindowName(workflowId: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: tmux target syntax forbids the separator and control characters, so the pattern is intentionally their class.
	return workflowId.replace(/[:\x00-\x1f]/g, "-").slice(0, 64) || "workspace";
}

/**
 * The argv the spawned window runs: this executable again, at the given route,
 * attached to the server the parent is already talking to. `--attach-url` is
 * what keeps the child from starting a second server (an explicit URL means
 * "attach to what is running"). Pure so the launch shape is testable.
 */
export function viewWindowArgs(
	request: ViewWindowRequest,
	options: { entry?: string; execPath?: string } = {},
): string[] {
	return [
		options.execPath ?? process.execPath,
		...(options.entry ? [options.entry] : []),
		"home",
		"--repo",
		request.repository,
		"--attach-url",
		request.attachUrl,
		...(request.token ? ["--attach-token", request.token] : []),
		"--route",
		request.routeJson,
	];
}

/**
 * Open one shell view in a new tmux window. This is tmux-only: a window is a
 * request for the multiplexer the developer chose to run the shell in, so
 * without a tmux client there is no local fallback and the caller reports why.
 */
export async function openViewWindow(
	request: ViewWindowRequest,
): Promise<WindowResult> {
	if (!tmuxClient() || !Bun.which("tmux"))
		return {
			ok: false,
			reason: "tmux is not available; run the shell inside a tmux client",
		};
	const name = tmuxWindowName(request.name);
	const argv = viewWindowArgs(request, { entry: selfExecEntry() });
	const process = Bun.spawn(
		["tmux", "new-window", "-n", name, "-c", request.cwd, "--", ...argv],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	const stderr = await new Response(process.stderr).text();
	const code = await process.exited;
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

/** The editor command for one file/line: `$EDITOR` (or `vi`) with a `+line`
 * argument, the same convention the pane command used. */
export function editorSideApp(
	file: string,
	line: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): SideAppRequest {
	return {
		command: env.EDITOR || "vi",
		args: [`+${line ?? 1}`, file],
		cwd: file.slice(0, Math.max(0, file.lastIndexOf("/"))) || ".",
	};
}

/** The renderer surface the local fallback suspends; optional so a test or a
 * headless caller can launch without a terminal. */
export interface SideAppRenderer {
	suspend?: () => void;
	resume?: () => void;
}

async function spawnLocal(
	request: SideAppRequest,
	captureStderr: boolean,
): Promise<SideAppOutcome> {
	const renderer = globalThis.__renderer as SideAppRenderer | undefined;
	renderer?.suspend?.();
	try {
		const child = Bun.spawn([request.command, ...request.args], {
			cwd: request.cwd,
			stdio: captureStderr
				? ["inherit", "inherit", "pipe"]
				: ["inherit", "inherit", "inherit"],
		});
		const stderr = captureStderr ? await new Response(child.stderr).text() : "";
		const status = await child.exited;
		return { mode: "local", status, stderr };
	} finally {
		renderer?.resume?.();
	}
}

async function spawnTmux(request: SideAppRequest): Promise<SideAppOutcome> {
	// `tmux new-window`'s status is the *request's* outcome — the server is gone,
	// the window limit is reached, or `-c` names a directory that no longer exists
	// — which is what a caller that reports failures needs, exactly as
	// `openViewWindow` treats it.
	const child = Bun.spawn(["tmux", ...tmuxSideAppArgs(request)], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr = await new Response(child.stderr).text();
	const status = await child.exited;
	return { mode: "tmux", status, stderr };
}

/** How one side-app launch went. A local spawn reports the app's own exit
 * status; a tmux launch reports the window request's. */
export interface SideAppOutcome {
	readonly mode: SideAppMode;
	/** The process's exit status (`0` is success). */
	readonly status?: number;
	/** What the process wrote to stderr. */
	readonly stderr?: string;
}

/**
 * Open one side app and answer how the launch went, so a caller that has
 * something to say about a failure can say it. A caller with nothing to say uses
 * `openSideApp`, which keeps the fully inherited stdio of an interactive app.
 */
export async function runSideApp(
	request: SideAppRequest,
): Promise<SideAppOutcome> {
	if (sideAppMode() === "tmux") {
		try {
			return await spawnTmux(request);
		} catch {
			/* fall through to the local spawn */
		}
	}
	return await spawnLocal(request, true);
}

/**
 * Open one side app and resolve with the mode that ran. A tmux launch failure
 * falls back to the local spawn: the side app is a convenience, never a reason
 * to lose the editor. A launched app that exits non-zero is not this caller's
 * business — `runSideApp` is where that status is answered.
 */
export async function openSideApp(
	request: SideAppRequest,
): Promise<SideAppMode> {
	if (sideAppMode() === "tmux") {
		try {
			await spawnTmux(request);
			return "tmux";
		} catch {
			/* fall through to the local spawn */
		}
	}
	return (await spawnLocal(request, false)).mode;
}
