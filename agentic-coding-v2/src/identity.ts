import path from "node:path";
import { digest } from "./config.ts";
import type { Invocation, Timing } from "./state.ts";

export function invocationFingerprint(
	invocation: Invocation,
	occurrence: string | null,
): string {
	// Explicit fields make JSON property ordering irrelevant. Do not resolve the filesystem
	// or current profile here: retries must find admitted work after configuration changes.
	return digest(
		JSON.stringify({
			topicId: invocation.topicId,
			skill: invocation.skill,
			profile: invocation.profile,
			repository: path.resolve(invocation.repository),
			inputs: invocation.inputs,
			relatedTo: invocation.relatedTo ?? null,
			policy: invocation.policy,
			occurrence,
			...(invocation.baseRef !== undefined && invocation.baseRef !== "HEAD"
				? { baseRef: invocation.baseRef }
				: {}),
		}),
	);
}
export function scheduleFingerprint(
	invocation: Invocation,
	timing: Timing,
	lateGraceMs: number | null,
): string {
	const clock =
		timing.kind === "once"
			? [timing.kind, timing.at]
			: timing.kind === "interval"
				? [timing.kind, timing.everyMs, timing.anchor]
				: [
						timing.kind,
						timing.timezone,
						[...new Set(timing.weekdays)].sort((a, b) => a - b),
						timing.hour,
						timing.minute,
					];
	return digest(
		JSON.stringify([
			invocation.requestId,
			invocationFingerprint(invocation, null),
			clock,
			lateGraceMs,
		]),
	);
}
