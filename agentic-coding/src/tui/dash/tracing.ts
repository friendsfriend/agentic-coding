/** TUI-owned operational tracing: one completed, receiver-compatible OTLP span
 * per dashboard/overview/observability/process outcome. Transport is delegated
 * to the workflow's bounded `TraceExporter` (OTLP HTTP, 750 ms budget), and
 * identity comes from the shared W3C helpers — no second debug-file protocol.
 *
 * Export is observational: `traceTui` must never change UI control flow, and a
 * failed export is swallowed.
 *
 * Value contract: every emitted attribute value is a bounded, printable-ASCII
 * enumerated constant chosen by TUI-owned code (surface/action/key/modal/view/
 * phase/step/status/count). Free-form user text, credentials, and developer
 * input must never reach a span: the attribute allowlist drops anything outside
 * those keys, per-character key diagnostics must be context-gated via
 * `isKeyTraceSuppressed` while passphrase prompts, search, or filters could be
 * receiving input, and non-printable values are filtered below. */
import { TraceExporter } from "../../workflow/effects";
import { childTrace } from "../../workflow/observability";

export type TuiTraceOutcome = "ok" | "error";

/** The full set of emittable TUI attribute names. Callers pass unqualified
 * keys; the helper namespaces them with `tui.` and drops everything else. */
const ALLOWED_ATTRIBUTE_KEYS = new Set([
	"surface",
	"action",
	"kind",
	"key",
	"modal",
	"view",
	"phase",
	"step",
	"status",
	"count",
]);

const MAX_ATTRIBUTE_LENGTH = 96;

/** True when a keystroke could be character entry into a passphrase prompt,
 * search, filter, or wiki-comment field — per-character input must never reach
 * a span, so key diagnostics are suppressed in these contexts. `anyModalOpen`
 * covers the embedded dashboard's text-entry prompts (e.g. the
 * credentials/askpass modal), which can receive characters that fall outside
 * its keymap layer's bound set. `wikiCommentEntry` covers the wiki comment
 * editor, which runs with the shared keymap modal at "none". */
export function isKeyTraceSuppressed(input: {
	anyModalOpen: boolean;
	searchEntry: boolean;
	filterEntry: boolean;
	wikiCommentEntry: boolean;
}): boolean {
	return (
		input.anyModalOpen ||
		input.searchEntry ||
		input.filterEntry ||
		input.wikiCommentEntry
	);
}

const exporter = new TraceExporter();

function boundedAttributes(
	attributes: Record<string, unknown>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		)
			continue;
		const clean = String(value).replace(/\s+/g, " ").trim();
		// Keep only printable-ASCII enumerated constants; control bytes, escape
		// sequences, and non-ASCII text cannot be span values.
		if (!/^[\x20-\x7E]*$/.test(clean)) continue;
		result[`tui.${key}`] = clean.slice(0, MAX_ATTRIBUTE_LENGTH);
	}
	return result;
}

/** Emit one completed TUI span with a generated trace/span identity. Never
 * throws: a transport or serialization failure leaves the caller untouched. */
export function traceTui(
	name: string,
	attributes: Record<string, unknown> = {},
	outcome: TuiTraceOutcome = "ok",
	durationMs = 0,
): void {
	try {
		const now = Date.now();
		const context = childTrace();
		const startedAt = now - Math.max(0, durationMs);
		exporter.export({
			traceId: context.traceId,
			spanId: context.spanId,
			name,
			startTimeUnixNano: (BigInt(startedAt) * 1_000_000n).toString(),
			endTimeUnixNano: (BigInt(now) * 1_000_000n).toString(),
			attributes: {
				...boundedAttributes(attributes),
				"tui.outcome": outcome,
			},
			status: outcome === "error" ? "ERROR" : "OK",
		});
	} catch {
		/* observational: tracing never affects TUI control flow */
	}
}
