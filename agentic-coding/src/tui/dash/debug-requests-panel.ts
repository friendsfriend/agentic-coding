// The delegated debug requests view model (add-debug-subagent-requests).
//
// Manifest in, display data out: one row per request (status, caller role,
// duration, goal), and the detail lines the dialog reads — the request's own
// summary, the evidence filed under it, the files that changed while it ran and
// the report itself. No I/O and no clock: the read already timed the request and
// the report text arrives with it.
import type { DebugRequestView } from "../../contracts/environment.ts";

/** What the request read is doing. `ready` with nothing listed is a fact the
 * read established — this workflow delegated nothing — not a default. */
export type DebugRequestsReadState = "loading" | "ready" | "error";

/** The status glyph, so a row is scannable without reading the word. */
const STATUS_GLYPH: Readonly<Record<DebugRequestView["status"], string>> =
	Object.freeze({
		queued: "◷",
		running: "◐",
		done: "✓",
		failed: "✗",
		cancelled: "⊘",
	});

/** A duration in the coarsest unit that still says something. A request that has
 * not finished has no duration: it reads as the status it is in. */
export function debugRequestDuration(seconds: number | undefined): string {
	if (seconds === undefined) return "—";
	if (seconds < 90) return `${seconds}s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

/** One request's list row: status, who asked, how long it took, and the first
 * line of what it was asked to establish. */
export function debugRequestRowLabel(request: DebugRequestView): string {
	const goal = request.goal.trim().split(/\r?\n/)[0] ?? "";
	return `${STATUS_GLYPH[request.status]} ${request.status} · ${request.callerRole} · ${debugRequestDuration(request.durationSeconds)} · ${goal}`;
}

/** One evidence entry's line: what it is, its id (the report cites these) and
 * its caption. */
export function debugRequestEvidenceLine(
	entry: DebugRequestView["evidence"][number],
): string {
	const caption = entry.caption.trim();
	return `  ${entry.id} · ${entry.kind}${caption ? ` · ${caption}` : ""}`;
}

/** Every line the detail pane renders: the request's summary, its evidence, the
 * files that changed while it ran, and then the report. The report comes last
 * because it is the long part, and scrolling reads the summary first. */
export function debugRequestDetailLines(request: DebugRequestView): string[] {
	const lines = [
		`${STATUS_GLYPH[request.status]} ${request.status} · ${request.callerRole} · ${debugRequestDuration(request.durationSeconds)}`,
		`created ${request.createdAt}${request.finishedAt ? ` · finished ${request.finishedAt}` : ""}`,
		`delivery ${request.delivered ? "injected into the caller conversation" : "not delivered (the caller had ended, or the request was cancelled)"}`,
		"",
		"# Goal",
		request.goal.trim(),
	];
	if (request.context?.trim())
		lines.push("", "# Context", request.context.trim());
	lines.push(
		"",
		`# Changed files (${request.changedFiles.length})`,
		...(request.baseline === "usable"
			? []
			: [
					"  baseline unavailable: tracked changes could not be measured, so this is only the untracked delta",
				]),
		...(request.changedFiles.length
			? request.changedFiles.map((file) => `  ${file}`)
			: ["  none"]),
		"",
		`# Evidence (${request.evidence.length})`,
		...(request.evidence.length
			? request.evidence.map(debugRequestEvidenceLine)
			: ["  none attached"]),
	);
	if (request.report?.trim()) {
		lines.push("", "# Report", ...request.report.trim().split(/\r?\n/));
	} else if (request.status === "queued" || request.status === "running") {
		lines.push("", "# Report", "  the delegated run has not reported yet");
	} else {
		lines.push("", "# Report", "  no report was produced");
	}
	lines.push("", `# Report file`, `  ${request.reportPath ?? "none"}`);
	return lines;
}

/** What one key does in the debug requests dialog. The dialog is read-only, so
 * this is the whole surface: close, move the selection, scroll the report, open
 * the report file. A new key that would change state cannot be added without
 * changing this type, which is what the read-only assertion in the tests reads.
 */
export type DebugRequestsKeyAction =
	| { readonly kind: "close" }
	| { readonly kind: "select"; readonly index: number }
	| { readonly kind: "scroll"; readonly offset: number }
	| { readonly kind: "open" }
	| { readonly kind: "none" };

/** The dialog's keys, as a pure function of the key and the current selection.
 *
 * A shifted letter arrives as `name: "j"` with `shift: true` — the convention
 * the rest of this codebase relies on — so the modifier is tested **before** the
 * bare key: `J`/`K` scroll the report, `j`/`k` move between requests. */
export function debugRequestsKeyAction(
	key: { readonly name: string; readonly shift?: boolean },
	state: {
		readonly selection: number;
		readonly offset: number;
		readonly count: number;
	},
): DebugRequestsKeyAction {
	const name = key.name.toLowerCase();
	if (name === "escape") return { kind: "close" };
	if (name === "j" && key.shift === true)
		return { kind: "scroll", offset: state.offset + 1 };
	if (name === "k" && key.shift === true)
		return { kind: "scroll", offset: Math.max(0, state.offset - 1) };
	if (name === "j")
		return {
			kind: "select",
			index: Math.min(state.count - 1, state.selection + 1),
		};
	if (name === "k")
		return { kind: "select", index: Math.max(0, state.selection - 1) };
	if (name === "enter" || name === "return") return { kind: "open" };
	return { kind: "none" };
}

/** The request rows one list column renders: a window of `lines` rows that
 * always contains the selection, so the highlight can never leave the rendered
 * rows however many requests the workflow accumulated. */
export function debugRequestListWindow<T>(
	rows: readonly T[],
	selectedIndex: number,
	lines: number,
): readonly T[] {
	const size = Math.max(1, lines);
	if (rows.length <= size) return rows;
	const selected = Math.max(0, Math.min(selectedIndex, rows.length - 1));
	const start = Math.max(
		0,
		Math.min(selected - Math.floor(size / 2), rows.length - size),
	);
	return rows.slice(start, start + size);
}

/** One window of `lines` at `offset`, clamped so a shrinking request (or a
 * refreshed read) never leaves the view scrolled past its own end. */
export function debugRequestWindow(
	lines: readonly string[],
	offset: number,
	height: number,
): { readonly start: number; readonly visible: readonly string[] } {
	const size = Math.max(1, height);
	const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - size)));
	return { start, visible: lines.slice(start, start + size) };
}
