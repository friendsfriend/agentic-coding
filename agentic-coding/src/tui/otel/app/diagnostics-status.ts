// The shell footer's diagnostics segment.
//
// The freeze the developer reports is invisible until something names it: this
// is the smallest surface that shows it while it happens — the worst main-thread
// lag this process recorded recently, and how many spikes there were — pinned in
// the footer next to `?` help. The full record (`agentic-coding diagnostics`,
// or SIGUSR2 for a summary of the running process) carries the details.
//
// The text is derived from the monitor's own bounded spike ring, never from
// workflow content: a count and a duration. It re-exports `diagnosticsSection`
// for the same reason: the shell times its own heavy sections, and a view file
// may not import a server module.
import { createSignal } from "solid-js";
import { diagnosticsMonitor } from "../../../server/diagnostics/instance.ts";

/** The section timer, re-exported so a `.tsx` view never imports a server
 * module itself (dashboard view isolation): this module is the shell's
 * composition seam to the monitor and performs no I/O — it reads a bounded
 * in-memory ring and hands the shell a string. */
export { diagnosticsSection } from "../../../server/diagnostics/instance.ts";

/** Spikes older than this are news no more: the footer reports what is current
 * rather than what happened an hour ago. */
const RECENT_WINDOW_MS = 10 * 60_000;

const [revision, setRevision] = createSignal(0);

/** Called by the monitor (through the shell's `onChange`) after every spike. */
export function noteDiagnosticsChange(): void {
	setRevision((value) => value + 1);
}

/** The footer's status text, or `undefined` while nothing went wrong. */
export function diagnosticsStatusText(now = Date.now()): string | undefined {
	// Tracked: the footer re-renders when the monitor reports a spike.
	revision();
	const monitor = diagnosticsMonitor();
	if (!monitor) return undefined;
	const cut = now - RECENT_WINDOW_MS;
	const recent = monitor
		.spikes()
		.filter((spike) => Date.parse(spike.at) >= cut);
	if (recent.length === 0) return undefined;
	const worst = recent.reduce(
		(max, spike) => (spike.lagMs > max ? spike.lagMs : max),
		0,
	);
	return `lag ${worst}ms ×${recent.length}`;
}
