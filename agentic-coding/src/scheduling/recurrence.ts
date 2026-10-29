import { Temporal } from "@js-temporal/polyfill";
import {
	type SchedulePreview,
	SchedulingError,
	type Timing,
} from "../contracts/scheduling.ts";

const MAX_INSTANT = 8_640_000_000_000_000;
export function instant(value: string): number {
	try {
		const at = Temporal.Instant.from(value).epochMilliseconds;
		if (!Number.isSafeInteger(at)) throw new Error();
		return at;
	} catch {
		throw new SchedulingError(
			"invalid-input",
			"Timing requires an explicit ISO instant with offset.",
		);
	}
}
export function validateTimezone(timezone: string): void {
	try {
		// Offset strings are not IANA zones. UTC is a named IANA zone too.
		if (!timezone || /^[+-]/.test(timezone)) throw new Error();
		Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone);
	} catch {
		throw new SchedulingError(
			"invalid-input",
			"An explicit valid IANA timezone is required.",
		);
	}
}
export function validateTiming(timing: Timing): Timing {
	validateTimezone(timing.timezone);
	if (timing.kind === "once") {
		instant(timing.at);
		if (
			timing.sourceDelayMs !== undefined &&
			(!Number.isSafeInteger(timing.sourceDelayMs) || timing.sourceDelayMs < 0)
		)
			throw new SchedulingError("invalid-input", "Invalid source delay.");
	} else if (timing.kind === "interval") {
		instant(timing.anchor);
		if (!Number.isSafeInteger(timing.everyMs) || timing.everyMs < 60_000)
			throw new SchedulingError(
				"invalid-input",
				"Interval must be at least one elapsed minute.",
			);
	} else {
		if (
			!Number.isInteger(timing.hour) ||
			timing.hour < 0 ||
			timing.hour > 23 ||
			!Number.isInteger(timing.minute) ||
			timing.minute < 0 ||
			timing.minute > 59 ||
			timing.weekdays.length < 1 ||
			timing.weekdays.length > 7 ||
			new Set(timing.weekdays).size !== timing.weekdays.length ||
			timing.weekdays.some(
				(day) => !Number.isInteger(day) || day < 1 || day > 7,
			)
		)
			throw new SchedulingError(
				"invalid-input",
				"Calendar requires distinct ISO weekdays and a valid hour/minute.",
			);
	}
	return timing;
}
/** Local selections are never interpreted using the machine's timezone. */
export function resolveLocalOnce(
	local: string,
	timezone: string,
	fold?: "earlier" | "later",
): Timing {
	validateTimezone(timezone);
	try {
		const value = Temporal.PlainDateTime.from(local);
		const earlier = value.toZonedDateTime(timezone, {
			disambiguation: "earlier",
		});
		const later = value.toZonedDateTime(timezone, { disambiguation: "later" });
		if (
			!earlier.toPlainDateTime().equals(value) ||
			!later.toPlainDateTime().equals(value)
		)
			throw new Error();
		if (
			earlier.epochMilliseconds !== later.epochMilliseconds &&
			fold === undefined
		)
			throw new Error();
		const selected = fold === "later" ? later : earlier;
		return { kind: "once", at: selected.toInstant().toString(), timezone };
	} catch {
		throw new SchedulingError(
			"invalid-input",
			"Local time is nonexistent, invalid, or ambiguous without an explicit fold choice.",
		);
	}
}
export function resolveDelay(
	delayMs: number,
	timezone: string,
	now: number,
): Timing {
	validateTimezone(timezone);
	if (
		!Number.isSafeInteger(delayMs) ||
		delayMs < 0 ||
		!Number.isSafeInteger(now + delayMs) ||
		Math.abs(now + delayMs) > MAX_INSTANT
	)
		throw new SchedulingError(
			"invalid-input",
			"Delay is outside the supported range.",
		);
	return {
		kind: "once",
		at: new Date(now + delayMs).toISOString(),
		sourceDelayMs: delayMs,
		timezone,
	};
}
/** First nominal slot >= at. Caller persists its cursor to prevent clock-rewind replay. */
export function nextSlot(timing: Timing, at: number): number | null {
	validateTiming(timing);
	if (!Number.isSafeInteger(at) || Math.abs(at) > MAX_INSTANT)
		throw new SchedulingError(
			"invalid-input",
			"Clock instant is outside the supported range.",
		);
	if (timing.kind === "once") {
		const due = instant(timing.at);
		return due >= at ? due : null;
	}
	if (timing.kind === "interval") {
		const anchor = instant(timing.anchor);
		const next =
			anchor +
			Math.max(0, Math.ceil((at - anchor) / timing.everyMs)) * timing.everyMs;
		return Number.isSafeInteger(next) && next <= MAX_INSTANT ? next : null;
	}
	let date = Temporal.Instant.fromEpochMilliseconds(at)
		.toZonedDateTimeISO(timing.timezone)
		.toPlainDate();
	// A weekly recurrence needs <= 7 dates, plus a skipped DST date. Bound corrupt/out-of-range work.
	for (let i = 0; i < 15; i++, date = date.add({ days: 1 })) {
		if (!timing.weekdays.includes(date.dayOfWeek)) continue;
		const local = date.toPlainDateTime({
			hour: timing.hour,
			minute: timing.minute,
		});
		const zoned = local.toZonedDateTime(timing.timezone, {
			disambiguation: "earlier",
		});
		if (!zoned.toPlainDateTime().equals(local)) continue;
		if (zoned.epochMilliseconds >= at) return zoned.epochMilliseconds;
	}
	throw new SchedulingError(
		"invalid-input",
		"No calendar slot in the bounded preview horizon.",
	);
}
export function previewTiming(timing: Timing, now: number): SchedulePreview {
	const next: SchedulePreview["next"] = [];
	let at = now;
	for (let i = 0; i < 5; i++) {
		const due = nextSlot(timing, at);
		if (due === null) break;
		const value = Temporal.Instant.fromEpochMilliseconds(due);
		next.push({
			at: value.toString(),
			local: value.toZonedDateTimeISO(timing.timezone).toString(),
		});
		if (due === MAX_INSTANT) break;
		at = due + 1;
	}
	return { timing, next, dstPolicy: "skip-gap/earlier-fold", noOverlap: "job" };
}
/** Bounded missed-range chunk. Calendar callers persist/aggregate partial chunks between ticks. */
export function missedRange(
	timing: Timing,
	first: number,
	before: number,
): { count: number; last: number; next: number | null } {
	if (first >= before) return { count: 0, last: first, next: first };
	if (timing.kind === "once") return { count: 1, last: first, next: null };
	if (timing.kind === "interval") {
		const count = Math.ceil((before - first) / timing.everyMs);
		return {
			count,
			last: first + (count - 1) * timing.everyMs,
			next: nextSlot(timing, before),
		};
	}
	let count = 0,
		last = first,
		slot: number | null = first;
	while (slot !== null && slot < before && count < 100) {
		count++;
		last = slot;
		slot = nextSlot(timing, slot + 1);
	}
	return { count, last, next: slot };
}
