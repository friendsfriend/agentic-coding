/** @jsxImportSource @opentui/solid */
// An embedded terminal coding agent page.
//
// One long-lived agent client runs on a real PTY and is rendered by
// OpenTUI's `EmbeddedTerminalRenderable`. The shell keeps this view mounted
// while the reader visits other pages (the wrapper in App hides it), so the
// agent session, its scrollback and any running turn survive navigation.
// Keys and mouse input are handled by the renderable itself while it has
// focus; the shell only keeps Ctrl+S/Ctrl+H/Ctrl+L (see App).
import {
	type EmbeddedTerminalRenderable,
	RenderableEvents,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { uiColors } from "@ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import "./embedded-terminal.ts";
import type {
	TerminalAgentLauncher,
	TerminalAgentProcess,
} from "../app/terminal-agent-process.ts";

export interface EmbeddedAgentViewProps {
	/** Human name used in startup and exit notices ("OpenCode", "Pi"). */
	readonly label: string;
	/** Project directory the agent runs in. */
	readonly cwd: string;
	/** The page body holds focus and no shell overlay is on top. */
	readonly active: () => boolean;
	/** The terminal itself took focus (for example, a mouse click). */
	readonly onFocus: () => void;
	/** The agent process launcher. Tests inject a fake; the shell passes the
	 * real PTY launcher for this page. */
	readonly launcher: TerminalAgentLauncher;
}

export function EmbeddedAgentView(props: EmbeddedAgentViewProps) {
	const dimensions = useTerminalDimensions();
	// Only the very first frame uses this: OpenTUI reports the real layout size
	// through `onTerminalResize` before the PTY has to draw anything.
	const initial = {
		cols: Math.max(20, dimensions().width - 2),
		rows: Math.max(6, dimensions().height - 7),
	};
	const [terminal, setTerminal] = createSignal<EmbeddedTerminalRenderable>();
	const [started, setStarted] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const [exitCode, setExitCode] = createSignal<number>();
	let process: TerminalAgentProcess | undefined;
	let running = false;
	let live = true;
	/** Ignore `focused` emitted by our own sync; only native/mouse focus should
	 * ask the shell to move its panel focus back to content. */
	let syncingShellFocus = false;
	let size = { ...initial };
	/** Focus and terminal responses produced before the PTY exists. */
	let pending: Uint8Array[] = [];

	const stopProcess = (): void => {
		const current = process;
		process = undefined;
		running = false;
		current?.stop();
		pending = [];
	};

	const fail = (message: string): void => {
		if (!live) return;
		live = false;
		terminal()?.blur();
		stopProcess();
		setStarted(false);
		setError(message);
	};

	const handleData = (data: Uint8Array): void => {
		if (!live) return;
		if (running && process) process.write(data);
		else if (started()) return;
		else pending.push(data);
	};

	const handleResize = (cols: number, rows: number): void => {
		size = { cols, rows };
		if (running) process?.resize(cols, rows);
	};

	// Focus follows the shell's panel model. `started` is a dependency so the
	// first focus happens after the PTY exists and its onData handler is
	// installed; the focus sequence is then delivered instead of dropped.
	createEffect(() => {
		const view = terminal();
		if (!view || !started()) return;
		syncingShellFocus = true;
		try {
			if (props.active()) view.focus();
			else view.blur();
		} finally {
			syncingShellFocus = false;
		}
	});

	onMount(() => {
		const view = terminal();
		if (!view) return;
		const focusListener = (): void => {
			if (!syncingShellFocus) props.onFocus();
		};
		view.on(RenderableEvents.FOCUSED, focusListener);
		onCleanup(() => view.off(RenderableEvents.FOCUSED, focusListener));
		try {
			process = props.launcher({
				cwd: props.cwd,
				cols: view.width || size.cols,
				rows: view.height || size.rows,
				onData: (data) => {
					if (live) view.write(data);
				},
				onExit: (code) => {
					if (!live) return;
					running = false;
					terminal()?.blur();
					setStarted(false);
					setExitCode(code);
				},
				onError: (cause) => fail(cause.message),
			});
		} catch (cause) {
			fail(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		running = true;
		const current = process;
		for (const chunk of pending) current.write(chunk);
		pending = [];
		setStarted(true);
	});

	onCleanup(() => {
		live = false;
		stopProcess();
	});

	return (
		<box
			style={{
				flexGrow: 1,
				width: "100%",
				minWidth: 0,
				minHeight: 0,
				flexDirection: "column",
			}}
		>
			<Show when={error()}>
				{(message) => (
					<box style={{ flexGrow: 1, minHeight: 0, paddingTop: 1 }}>
						<text fg={uiColors.error}>
							{`${props.label} could not start: ${message()}`}
						</text>
					</box>
				)}
			</Show>
			<Show when={!error()}>
				<embedded_terminal
					ref={(view) => setTerminal(view)}
					style={{ flexGrow: 1, width: "100%", minWidth: 0, minHeight: 0 }}
					cols={initial.cols}
					rows={initial.rows}
					selectable
					onData={handleData}
					onTerminalResize={handleResize}
				/>
			</Show>
			<Show when={exitCode() !== undefined}>
				<text fg={uiColors.textMuted}>
					{exitCode() === 0
						? `${props.label} exited.`
						: `${props.label} exited with code ${exitCode()}.`}
				</text>
			</Show>
		</box>
	);
}
