// add-pi-durable-runtime: pi-durable never threads pi-ai's `options.sessionId`,
// which the built-in `opencode-go` provider needs to emit its required
// `x-opencode-session` header. Without it every durable generation fails 400
// `MissingSessionID` and the run settles `model_error` — the dashboard shows a
// worker that starts and is idle again instantly.
import { expect, test } from "bun:test";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import { withDurableSession } from "../src/agent-host/host.ts";

function fakeOpenCodeProvider(seen: Array<string | undefined>): Provider {
	return {
		id: "opencode-go",
		name: "fake opencode-go",
		auth: {} as never,
		getModels: () => [],
		stream: () => {
			throw new Error("stream is unused by this test");
		},
		streamSimple: (_model: unknown, _context: unknown, options?: unknown) => {
			seen.push((options as { sessionId?: string } | undefined)?.sessionId);
			return undefined as never;
		},
	} as unknown as Provider;
}

test("a durable generation gets a session id for the opencode-go provider", () => {
	const models = createModels();
	const seen: Array<string | undefined> = [];
	models.setProvider(fakeOpenCodeProvider(seen));
	withDurableSession(models);
	const provider = models.getProvider("opencode-go");
	provider?.streamSimple({} as never, {} as never, undefined);
	provider?.streamSimple({} as never, {} as never, undefined);
	expect(seen).toHaveLength(2);
	expect(typeof seen[0]).toBe("string");
	expect((seen[0] ?? "").length).toBeGreaterThan(0);
	// One id per host process, so provider session affinity stays stable.
	expect(seen[0]).toBe(seen[1]);
});

test("a caller-supplied session id is left untouched", () => {
	const models = createModels();
	const seen: Array<string | undefined> = [];
	models.setProvider(fakeOpenCodeProvider(seen));
	withDurableSession(models);
	models
		.getProvider("opencode-go")
		?.streamSimple(
			{} as never,
			{} as never,
			{ sessionId: "explicit" } as never,
		);
	expect(seen).toEqual(["explicit"]);
});

test("a collection without the provider is returned unchanged", () => {
	const models = createModels();
	expect(withDurableSession(models)).toBe(models);
});
