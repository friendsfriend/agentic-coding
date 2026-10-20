// Client-side application of a watch patch. The host streams the same chord
// delta operations it receives from the conversation view, so the client can
// advance its cached snapshot without re-reading or re-parsing a full
// transcript. The previous value is immutable and structurally shared: only
// the containers a patch touches are copied, which is what makes a token-rate
// stream cheap.
//
// Pure: no I/O, no host import. The operations come from the local host over
// its private Unix socket, but `applyImmutable` still validates their shape and
// refuses prototype-reaching paths.
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { WatchPatch } from "./protocol.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Advance one cached view by a patch. The host's initial snapshot carries the
 * measured timings as a top-level field; a root replacement operation does not,
 * so the field is carried across unless the patch itself supplies a new map. */
export function applyWatchPatch(previous: unknown, patch: WatchPatch): unknown {
	const next = applyImmutable(previous, patch.ops as readonly Op[]);
	if (patch.timings !== undefined) {
		if (!isRecord(next))
			throw new Error("watch patch replaced the view with a non-object");
		return { ...next, timings: patch.timings };
	}
	if (!isRecord(previous) || !isRecord(next)) return next;
	if (previous.timings === undefined || next.timings !== undefined) return next;
	return { ...next, timings: previous.timings };
}
