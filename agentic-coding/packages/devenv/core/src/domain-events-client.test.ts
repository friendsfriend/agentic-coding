import { expect, test } from "bun:test";
import type { ClientDeps } from "./client-types.ts";
import {
	type DomainEventMessage,
	subscribeDomainEvents,
} from "./domain-events-client.ts";

// The environment feature's domain-event source (show-environment-instances):
// golden `event:`/`data:` frames become typed messages, and a `resync` is what
// makes the slot store re-read its snapshot.

function sseResponse(frames: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

test("yields domain events and a resync from one stream", async () => {
	const event = {
		instance: "instance-1",
		sequence: 1,
		domain: "environment",
		kind: "environment.slot.waiting",
		resource: "shop",
		at: "2026-01-01T00:00:00.000Z",
		payload: { app: "shop", waiter: "workflow:b" },
	};
	const deps = {
		baseUrl: "http://server",
		sseFetchFn: async () =>
			sseResponse([
				'event: hello\ndata: {"instance":"instance-1","apiVersion":1}\n\n',
				`event: domain\ndata: ${JSON.stringify(event)}\n\n`,
				'event: resync\ndata: {"reason":"cursor outside replay window"}\n\n',
			]),
		onError: () => {},
	} as unknown as ClientDeps;
	const messages: DomainEventMessage[] = [];
	for await (const message of subscribeDomainEvents(deps))
		messages.push(message);
	expect(messages).toEqual([
		{ type: "event", event },
		{ type: "resync", reason: "cursor outside replay window" },
	]);
});

test("a refused subscription raises through the client error handler", async () => {
	const errors: Array<[string, string]> = [];
	const deps = {
		baseUrl: "http://server",
		sseFetchFn: async () =>
			new Response(JSON.stringify({ message: "no capability" }), {
				status: 503,
			}),
		onError: (title: string, message: string) => errors.push([title, message]),
	} as unknown as ClientDeps;
	await expect(
		(async () => {
			for await (const _message of subscribeDomainEvents(deps)) {
				// Draining is the point: the first read must raise.
			}
		})(),
	).rejects.toThrow("no capability");
	expect(errors).toEqual([["HTTP 503 Error", "no capability"]]);
});
