import { Temporal } from "@js-temporal/polyfill";
import type { Timing } from "./state.ts";

export function nextDue(timing: Timing, after: number): number | null {
	if (!Number.isSafeInteger(after) || after < 0)
		throw new Error("Invalid clock");
	if (timing.kind === "once") {
		if (!Number.isSafeInteger(timing.at) || timing.at < 0)
			throw new Error("Invalid instant");
		return timing.at > after ? timing.at : null;
	}
	if (timing.kind === "interval") {
		if (
			!Number.isSafeInteger(timing.everyMs) ||
			timing.everyMs < 1000 ||
			!Number.isSafeInteger(timing.anchor) ||
			timing.anchor < 0
		)
			throw new Error("Invalid interval");
		const result =
			timing.anchor +
			Math.max(0, Math.floor((after - timing.anchor) / timing.everyMs) + 1) *
				timing.everyMs;
		if (!Number.isSafeInteger(result))
			throw new Error("Interval exceeds clock range");
		return result;
	}
	if (
		!timing.weekdays.length ||
		timing.weekdays.some(
			(day) => !Number.isInteger(day) || day < 1 || day > 7,
		) ||
		!Number.isInteger(timing.hour) ||
		timing.hour < 0 ||
		timing.hour > 23 ||
		!Number.isInteger(timing.minute) ||
		timing.minute < 0 ||
		timing.minute > 59
	)
		throw new Error("Invalid calendar timing (weekdays are ISO 1–7)");
	const instant = Temporal.Instant.fromEpochMilliseconds(after);
	const start = instant.toZonedDateTimeISO(timing.timezone).toPlainDate();
	for (let offset = 0; offset < 9; offset++) {
		const day = start.add({ days: offset });
		if (!timing.weekdays.includes(day.dayOfWeek)) continue;
		// Compatible disambiguation: spring gaps advance; fall folds use the first instant only.
		const candidate = day.toZonedDateTime({
			timeZone: timing.timezone,
			plainTime: Temporal.PlainTime.from({
				hour: timing.hour,
				minute: timing.minute,
			}),
		}).epochMilliseconds;
		if (candidate > after) return candidate;
	}
	throw new Error("No next calendar slot");
}
