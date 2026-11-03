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
/** Timing refers to a host-observed completed-line suffix, never text-parsed app dates.
 * Length receipts avoid duplicating log text; missing/corrupt receipts cannot widen reads. */
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
	if (
		timing.basis !== "host-receipt-completed-lines" ||
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
		const start = end - entry.characters;
		if (!source.slice(start, end).endsWith("\n"))
			return unavailable("invalid-capture");
		const text = source.slice(Math.max(start, minimum), end);
		end = start;
		if (!text) continue;
		const part = text.slice(0, -1).split("\n");
		dated += part.length;
		if (BigInt(entry.receivedAt) * 1000000n >= since.epochNanoseconds)
			chunks.unshift(part);
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
