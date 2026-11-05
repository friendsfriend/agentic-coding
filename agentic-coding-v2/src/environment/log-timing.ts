import { Temporal } from "@js-temporal/polyfill";
import type { LogTiming } from "./process.ts";
export function logSince(value: string | undefined) {
	if (value === undefined) return undefined;
	try {
		if (typeof value !== "string" || value.length > 128) throw new Error();
		return Temporal.Instant.from(value);
	} catch {
		throw new Error(
			"Log since must be an explicit ISO 8601 instant with a timezone offset",
		);
	}
}
/** Timing refers to a completed-line suffix observed either by this host or by the
 * runtime's own line timestamp, never a date parsed out of app text. Length receipts
 * avoid duplicating log text; missing/corrupt receipts cannot widen reads. */
export function timedLines(
	source: string,
	lines: string[],
	timing: LogTiming | undefined,
	since: Temporal.Instant | undefined,
	boundaryLineWithheld: boolean,
) {
	const base = {
		basis: timing?.basis ?? null,
		since: since?.toString() ?? null,
		timingWindowTruncated: timing?.truncated ?? false,
	};
	if (!since)
		return {
			lines,
			timeSelection: {
				...base,
				availability: timing ? "available" : "not-captured",
			},
		};
	const unavailable = (availability: string) => ({
		lines: [] as string[],
		timeSelection: {
			...base,
			availability,
			untimedRetainedLines: lines.length,
			excludedOlderLines: 0,
		},
	});
	if (!timing) return unavailable("not-captured");
	const provider = timing.basis === "provider-event-time-completed-lines";
	if (
		(provider
			? timing.basis !== "provider-event-time-completed-lines"
			: timing.basis !== "host-receipt-completed-lines") ||
		!Array.isArray(timing.entries) ||
		timing.entries.length > 2048
	)
		return unavailable("invalid-capture");
	const chunks: string[][] = [];
	let end = source.length,
		dated = 0,
		older = 0;
	const minimum = boundaryLineWithheld ? source.indexOf("\n") + 1 : 0;
	for (const entry of timing.entries.toReversed()) {
		if (
			!entry ||
			typeof entry !== "object" ||
			!Number.isSafeInteger(entry.receivedAt) ||
			!Number.isInteger(entry.characters) ||
			entry.characters < 1 ||
			entry.characters > end
		)
			return unavailable("invalid-capture");
		// A provider line without a usable timestamp stays untimed: it is never
		// selected by since and never borrows a neighbouring line's event time.
		const at = provider
			? instantOf(entry.observedAt)?.epochNanoseconds
			: BigInt(entry.receivedAt) * 1000000n;
		const start = end - entry.characters;
		if (!source.slice(start, end).endsWith("\n"))
			return unavailable("invalid-capture");
		const text = source.slice(Math.max(start, minimum), end);
		end = start;
		if (!text) continue;
		const part = text.slice(0, -1).split("\n");
		if (at === undefined) continue;
		dated += part.length;
		if (at >= since.epochNanoseconds) chunks.unshift(part);
		else older += part.length;
	}
	return {
		lines: chunks.flat(),
		timeSelection: {
			...base,
			availability: "available",
			untimedRetainedLines: Math.max(0, lines.length - dated),
			excludedOlderLines: older,
		},
	};
}

/** A provider timestamp must be an explicit offset instant; it is never guessed. */
function instantOf(value: string | undefined): Temporal.Instant | null {
	if (typeof value !== "string" || value.length > 64) return null;
	try {
		return Temporal.Instant.from(value);
	} catch {
		return null;
	}
}

/** Keep a tail that starts on a completed-line boundary and retain exactly the
 * timing receipts that still describe it. A straddling receipt drops timing
 * entirely rather than shifting later event times onto different text. */
export function clampedCapture(
	source: string,
	cap: number,
	timing: LogTiming | undefined,
) {
	const truncated = source.length >= 64000 || source.length > cap;
	if (!truncated) return { output: source, truncated: false, timing };
	const suffix = source.slice(-cap),
		boundary = suffix.indexOf("\n"),
		output = boundary < 0 ? "" : suffix.slice(boundary + 1),
		dropped = source.length - output.length;
	if (!timing) return { output, truncated: true, timing: undefined };
	let consumed = 0,
		index = 0;
	for (; index < timing.entries.length; index++) {
		const entry = timing.entries[index];
		if (!entry) return { output, truncated: true, timing: undefined };
		if (consumed + entry.characters > dropped) break;
		consumed += entry.characters;
	}
	if (consumed !== dropped)
		return { output, truncated: true, timing: undefined };
	return {
		output,
		truncated: true,
		timing: { ...timing, entries: timing.entries.slice(index) },
	};
}
