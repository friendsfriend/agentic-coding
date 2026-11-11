// An embedded terminal coding agent's PTY process.
//
// Coding agents are real terminal applications, so the shell gives each one a
// real PTY (`Bun.Terminal`) and renders the bytes in an
// `EmbeddedTerminalRenderable`. One process lives for the shell's lifetime:
// navigating away hides the view but never stops the process, and only shell
// shutdown kills it. No flags are passed, so each agent uses its normal user
// configuration, model, agent and theme.
import { statSync } from "node:fs";

/** The terminal description the embedded TUIs expect. */
export const TERMINAL_AGENT_TERM = "xterm-256color";

export interface TerminalAgentProcess {
	readonly pid: number | undefined;
	write(data: Uint8Array): void;
	resize(cols: number, rows: number): void;
	stop(): void;
}

export interface StartTerminalAgentOptions {
	/** The project the TUI runs in: the shell's primary repository. */
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	readonly onData: (data: Uint8Array) => void;
	/** The process exited on its own (not through `stop`). */
	readonly onExit?: (code: number) => void;
	/** The PTY or process failed after startup. */
	readonly onError?: (error: Error) => void;
}

/** Launcher boundary for the view; kept injectable so the shell can test focus
 * and routing without starting the developer's real agent client. */
export type TerminalAgentLauncher = (
	options: StartTerminalAgentOptions,
) => TerminalAgentProcess;

/** A terminal column/row count that a PTY accepts. */
function terminalSize(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(2, Math.min(65535, Math.floor(value)));
}

function startTerminalAgent(
	label: string,
	command: string,
	options: StartTerminalAgentOptions,
): TerminalAgentProcess {
	let directoryExists = false;
	try {
		directoryExists = statSync(options.cwd).isDirectory();
	} catch {}
	if (!directoryExists)
		throw new Error(
			`${label} project directory does not exist or is not accessible: ${JSON.stringify(options.cwd)}`,
		);
	const executable = Bun.which(command);
	if (!executable)
		throw new Error(
			`${label} executable was not found on PATH. Ensure ${command} is installed and available in the environment that starts the shell.`,
		);
	let stopped = false;
	const terminal = new Bun.Terminal({
		cols: terminalSize(options.cols, 80),
		rows: terminalSize(options.rows, 24),
		name: TERMINAL_AGENT_TERM,
		data: (_terminal, data) => {
			if (!stopped) options.onData(data);
		},
	});
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn([executable], {
			cwd: options.cwd,
			env: {
				...process.env,
				TERM: TERMINAL_AGENT_TERM,
				COLORTERM: "truecolor",
			},
			terminal,
		});
	} catch (error) {
		try {
			terminal.close();
		} catch {}
		throw new Error(
			`Could not spawn ${JSON.stringify(executable)} in ${JSON.stringify(options.cwd)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	void proc.exited
		.then((code) => {
			if (!stopped) options.onExit?.(code);
		})
		.catch((error: unknown) => {
			if (stopped) return;
			options.onError?.(
				error instanceof Error ? error : new Error(String(error)),
			);
		});
	return {
		pid: proc.pid,
		write(data) {
			if (stopped) return;
			terminal.write(data);
		},
		resize(cols, rows) {
			if (stopped) return;
			terminal.resize(terminalSize(cols, 80), terminalSize(rows, 24));
			// Bun updates the PTY size without reliably notifying the child. TUIs
			// need SIGWINCH to read the new dimensions and repaint the added space.
			try {
				proc.kill("SIGWINCH");
			} catch {}
		},
		stop() {
			if (stopped) return;
			stopped = true;
			try {
				proc.kill("SIGTERM");
			} catch {}
			try {
				terminal.close();
			} catch {}
		},
	};
}

/**
 * Start `opencode` on a fresh PTY. Throws when the executable cannot be
 * spawned; a failure after startup is reported through `onError`.
 */
export function startOpenCode(
	options: StartTerminalAgentOptions,
): TerminalAgentProcess {
	return startTerminalAgent("OpenCode", "opencode", options);
}

/**
 * Start `pi` on a fresh PTY with its standard user configuration. Throws when
 * the executable cannot be spawned; a failure after startup is reported
 * through `onError`.
 */
export function startPi(
	options: StartTerminalAgentOptions,
): TerminalAgentProcess {
	return startTerminalAgent("Pi", "pi", options);
}
