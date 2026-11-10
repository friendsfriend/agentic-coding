/**
 * Domain event stream client (`GET /api/v1/events`).
 *
 * The dashboard's bounded domain stream: each SSE frame names one event
 * (`domain`) or a `resync` notification. The environment feature consumes
 * `environment.slot.*` from it, so a `resync` means the client fell outside the
 * server's replay window and must re-read an authoritative snapshot rather than
 * apply further live events.
 */
import type { ClientDeps } from "./client-types.ts";
import { handleFetchError } from "./error-handler.ts";

export interface DomainEventEnvelope {
	readonly instance: string;
	readonly sequence: number;
	readonly domain: string;
	readonly kind: string;
	readonly resource?: string;
	readonly runId?: string;
	readonly revision?: number;
	readonly at: string;
	readonly payload: unknown;
}

export type DomainEventMessage =
	| { readonly type: "event"; readonly event: DomainEventEnvelope }
	| { readonly type: "resync"; readonly reason: string };

function isEnvelope(value: unknown): value is DomainEventEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Record<string, unknown>;
	return (
		typeof event.instance === "string" &&
		typeof event.sequence === "number" &&
		typeof event.domain === "string" &&
		typeof event.kind === "string" &&
		typeof event.at === "string"
	);
}

function parseFrame(frame: string): DomainEventMessage | undefined {
	let name = "message";
	const data: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) name = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
	}
	if (data.length === 0) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(data.join("\n"));
	} catch {
		return undefined;
	}
	if (name === "domain" && isEnvelope(payload))
		return { type: "event", event: payload };
	if (name === "resync") {
		const reason = (payload as { reason?: unknown } | null)?.reason;
		return {
			type: "resync",
			reason: typeof reason === "string" ? reason : "resync",
		};
	}
	return undefined;
}

/**
 * Subscribe to the bounded domain stream (SSE). `cursor` resumes after a
 * sequence the caller already applied; omit it for live-only. Yields one
 * message per frame until the stream ends or `signal` aborts.
 */
export async function* subscribeDomainEvents(
	deps: ClientDeps,
	signal?: AbortSignal,
	cursor?: number,
): AsyncGenerator<DomainEventMessage> {
	const query = cursor === undefined ? "" : `?cursor=${cursor}`;
	const response = await deps.sseFetchFn(
		`${deps.baseUrl}/api/v1/events${query}`,
		{ signal, headers: { Accept: "text/event-stream" } },
	);
	if (!response.ok) await handleFetchError(response, deps.onError);

	const reader = response.body?.getReader();
	if (!reader) throw new Error("No response body");
	if (signal?.aborted) {
		await reader.cancel();
		return;
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const message = parseFrame(frame);
				if (message) yield message;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			/* reader may have been cancelled */
		}
	}
}
