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

/** One workflow workspace to open in a tmux window. */
export interface WorkspaceWindowRequest {
	/** Workflow id: the tmux window name. */
	name: string;
	/** Directory the window opens in (the workflow's worktree). */
	cwd: string;
}

export type WorkspaceWindowResult =
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
 * Open one workflow's workspace in a new tmux window, named after the
 * workflow. This is tmux-only: there is no local fallback, because a workspace
 * window is a request for the multiplexer the developer chose to run the shell
 * in. Without a tmux client the caller reports the reason.
 */
export async function openWorkspaceWindow(
	request: WorkspaceWindowRequest,
): Promise<WorkspaceWindowResult> {
	if (!tmuxClient() || !Bun.which("tmux"))
		return {
			ok: false,
			reason: "tmux is not available; run the shell inside a tmux client",
		};
	const name = tmuxWindowName(request.name);
	const process = Bun.spawn(
		["tmux", "new-window", "-n", name, "-c", request.cwd],
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

async function spawnLocal(request: SideAppRequest): Promise<void> {
	const renderer = globalThis.__renderer as SideAppRenderer | undefined;
	renderer?.suspend?.();
	try {
		const process = Bun.spawn([request.command, ...request.args], {
			cwd: request.cwd,
			stdio: ["inherit", "inherit", "inherit"],
		});
		await process.exited;
	} finally {
		renderer?.resume?.();
	}
}

async function spawnTmux(request: SideAppRequest): Promise<void> {
	const process = Bun.spawn(["tmux", ...tmuxSideAppArgs(request)], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	await process.exited;
}

/**
 * Open one side app and resolve with the mode that ran. A tmux launch failure
 * falls back to the local spawn: the side app is a convenience, never a reason
 * to lose the editor.
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
	await spawnLocal(request);
	return "local";
}
