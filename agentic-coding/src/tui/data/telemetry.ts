// Herdr and telemetry data selectors (establish-opencode-boundaries, task 4.3).
//
// Pane/agent observations and telemetry-database reads through the gateway.
// On-change callbacks invalidate cached data; none of them touch workflow
// state, so a pane or span arriving can never look like a workflow transition.
import { Schema } from "effect";
import type { SpanData, TraceSummaryPage } from "../../contracts/telemetry.ts";
import { cache, gateway, gatewayOrUndefined } from "./index.ts";

type Signal = AbortSignal | undefined;

export function tracesKey(changeId?: string, page?: number): string {
	return `telemetry:traces:${changeId ?? "*"}:${page ?? 1}`;
}

/** One page of the trace list (workflows, newest first). */
export async function loadTraces(
	options: {
		page?: number;
		perPage?: number;
		changeId?: string;
	},
	signal?: Signal,
): Promise<TraceSummaryPage | undefined> {
	return cache.load(
		tracesKey(options.changeId, options.page),
		() => gateway().telemetryTraces(options),
		{ signal },
	);
}

/** Bounded span read: one workflow's spans, or the newest spans overall. */
export async function loadSpans(
	options: {
		changeId?: string;
		limit?: number;
	},
	signal?: Signal,
): Promise<SpanData[] | undefined> {
	const key = options.changeId
		? `telemetry:spans:${options.changeId}`
		: `telemetry:spans:*:${options.limit ?? "recent"}`;
	return cache.load(
		key,
		async () =>
			(await gateway().telemetrySpans(options)) as unknown as SpanData[],
		{ signal },
	);
}

/** Workspaces the telemetry database knows about. */
export async function loadWorkspaces(
	signal?: Signal,
): Promise<
	Array<{ changeId: string; path: string; spanCount: number }> | undefined
> {
	return cache.load(
		"telemetry:workspaces",
		() => gateway().telemetryWorkspaces(),
		{
			signal,
		},
	);
}

/** Register the server-owned workspace watcher for a repository. */
export async function watchWorkspace(repo: string): Promise<void> {
	await gateway().telemetryWatch(repo);
}

export async function scanWorkspace(repo: string): Promise<number> {
	const scanned = await gateway().telemetryScan(repo);
	cache.invalidate("telemetry");
	return scanned;
}

export async function pruneTelemetry(days?: number): Promise<number> {
	const removed = await gateway().telemetryPrune(days);
	cache.invalidate("telemetry");
	return removed;
}

/** Telemetry changed (new spans ingested): drop the cached reads. This never
 * invalidates workflow state, because a span is not a transition. */
export function onTelemetryChange(): void {
	cache.invalidate("telemetry");
}

/** Herdr observation helper: pane identities arrive as an opaque payload the
 * caller narrows; the data layer only decides what to invalidate. */
export function onHerdrEvent(event: { data?: Record<string, unknown> }): void {
	const workspace = event.data?.workspace_id;
	if (typeof workspace === "string") cache.invalidate(`herdr:${workspace}`);
}

/** True when a transport is configured: the server owns the Herdr socket and
 * publishes `workflow.updated`, so the shell must not subscribe itself. */
export function serverOwnsHerdrSocket(): boolean {
	return gatewayOrUndefined() !== undefined;
}

/** Span shape guard used by callers that render a narrow subset. */
export function isSpanData(value: unknown): value is SpanData {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { spanId?: unknown }).spanId === "string"
	);
}

export const spanSchema = Schema.Unknown;
