import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { ClientConnection, dataList } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

const serialized = (value: unknown) => JSON.parse(JSON.stringify(value));

test("authenticated context inspection preserves native aligned contributions, ordered messages, reported usage and recorded timing without model calls or context adoption", async () => {
	const { app, fake } = await fixture();
	const model = fake.getModel();
	const source = "Supplied 😀e\u0301\r\n".repeat(60);
	// Public native passive admissions, not storage injection or UI helper tests.
	for (let index = 0; index < 27; index++) {
		const message = {
			...fauxAssistantMessage([
				fauxText(source),
				fauxText(""),
				fauxText(" \r\n "),
			]),
			provider: model.provider,
			model: model.id,
			responseModel: "",
			responseId: `recorded-${index}:approve:not-authority`,
			timestamp: index === 0 ? 0 : 1700000000000 + index,
			durationMs: index === 0 ? 0 : 10000 + index,
			providerThinkingLevel: "",
			endTurn: false,
			rawStopReason: "",
			usage: {
				input: 100 + index,
				output: 20 + index,
				cacheRead: 7,
				cacheWrite: 5,
				cacheWrite1h: 2,
				reasoning: index === 0 ? 0 : 3,
				totalTokens: 132 + index * 2,
				cost: {
					input: 0.0001,
					output: 0.0002,
					cacheRead: 0.00001,
					cacheWrite: 0.00002,
					total: index === 0 ? 0 : 0.00033,
				},
			},
		};
		await app.home.submit(
			{
				type: "write",
				entry: {
					kind: "fixture.context",
					data: { index, approved: true, conversationId: 999999 },
					model: [
						{ role: "user", content: `Input ${index}`, timestamp: index },
						message,
					],
				},
			},
			context,
		);
	}
	const host = serve(app);
	let client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const id = Number(app.home.id),
			before = await app.home.context(context);
		const result = await client.call("session.context", { id });
		expect(result.id).toBe(id);
		expect(result.head).toBeNull();
		expect(result.entries).toEqual(serialized(before.entries));
		expect(result.contributions).toEqual(serialized(before.contributions));
		expect(result.messages).toEqual(serialized(before.messages));
		expect(result.entries).toHaveLength(27);
		expect(result.contributions).toHaveLength(27);
		expect(result.messages).toHaveLength(54);
		expect(result.model).toEqual({
			provider: model.provider,
			modelId: model.id,
			catalogued: true,
			contextWindow: model.contextWindow,
			maxOutput: model.maxTokens,
		});
		expect(result.thinking).toBe("off");
		const first = result.messages.find(
			(message) => message.role === "assistant",
		);
		expect(first).toMatchObject({
			timestamp: 0,
			durationMs: 0,
			responseModel: "",
			providerThinkingLevel: "",
			rawStopReason: "",
			endTurn: false,
			usage: {
				reasoning: 0,
				cacheWrite1h: 2,
				cacheWrite: 5,
				cost: { total: 0 },
			},
		});
		expect(dataList(first?.content).map((part) => part.text)).toEqual([
			source,
			"",
			" \r\n ",
		]);
		const history = await client.call("session.read", { id });
		expect(history.usage).toEqual({
			input: 3051,
			output: 891,
			cacheRead: 189,
			cacheWrite: 135,
			cost: Array.from({ length: 26 }, () => 0.00033).reduce(
				(a, b) => a + b,
				0,
			),
		});
		const after = await app.home.context(context);
		expect(serialized(after)).toEqual(serialized(before));
		expect(fake.state.callCount).toBe(0);
		for (const invalid of [-1, 0.5, 999999])
			await expect(
				client.call("session.context", { id: invalid }),
			).rejects.toThrow("Native operation refused");
		const extra = { id, at: 0 };
		await expect(client.call("session.context", extra)).rejects.toThrow(
			"Native operation refused",
		);
		client.close();
		client = new ClientConnection(host.client);
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		expect(await client.call("session.context", { id })).toEqual(result);

		// Native edits alter model contributions, not raw retained history. Preserve
		// empty aligned contributions rather than filtering/reindexing the arrays.
		const target = before.entries[0],
			replacementTarget = before.entries[1];
		if (!target || !replacementTarget)
			throw new Error("Fixture context entries missing");
		const replacement = {
			role: "user" as const,
			content: "Replacement input only; not restored history",
			timestamp: 0,
		};
		await app.home.submit(
			{
				type: "write",
				entry: {
					kind: "fixture.context-edit",
					edits: [
						{ target: target.id, action: "omit" },
						{
							target: replacementTarget.id,
							action: "replace",
							messages: [replacement],
						},
					],
				},
			},
			context,
		);
		const edited = await client.call("session.context", { id });
		expect(edited.entries).toHaveLength(28);
		expect(edited.entries[0]).toEqual(result.entries[0]);
		expect(edited.entries[1]).toEqual(result.entries[1]);
		expect(edited.contributions[0]).toEqual([]);
		expect(edited.contributions[1]).toEqual([replacement]);
		expect(edited.contributions.at(-1)).toEqual([]);
		expect(edited.messages).toEqual(
			serialized((await app.home.context(context)).messages),
		);
		expect(
			edited.messages.some(
				(message) => message.responseId === "recorded-0:approve:not-authority",
			),
		).toBe(false);
		expect(result.messages).toHaveLength(54);
		expect(fake.state.callCount).toBe(0);

		// A native reset creates a context head, not an archive/transcript erasure.
		await app.home.reset("New handoff 😀e\u0301\r\n", context);
		const reset = await client.call("session.context", { id });
		const nativeReset = await app.home.context(context);
		expect(reset.head?.kind).toBe("pi.reset");
		expect(reset.entries).toEqual(serialized(nativeReset.entries));
		expect(reset.contributions).toEqual(serialized(nativeReset.contributions));
		expect(reset.messages).toEqual(serialized(nativeReset.messages));
		expect(JSON.stringify(reset.messages)).not.toContain(
			"recorded-0:approve:not-authority",
		);
		expect(
			(await client.call("session.read", { id })).entries.length,
		).toBeGreaterThan(reset.entries.length);
		expect(fake.state.callCount).toBe(0);
	} finally {
		client.close();
		host.stop();
	}
});

test("context inspection refuses a complete projection over budget without trimming or changing native context", async () => {
	const { app, fake } = await fixture();
	const content = "😀e\u0301\r\n".repeat(20000);
	await app.home.submit(
		{
			type: "write",
			entry: {
				kind: "fixture.large-context",
				model: [{ role: "user", content, timestamp: 0 }],
			},
		},
		context,
	);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const id = Number(app.home.id);
		await expect(client.call("session.context", { id })).rejects.toThrow(
			"Native operation refused",
		);
		// A refused large reply does not poison the next small authenticated response.
		expect(
			(await client.call("state.read", {})).sessions.some(
				(session) => session.id === id,
			),
		).toBe(true);
		expect((await app.home.context(context)).messages).toEqual([
			{ role: "user", content, timestamp: 0 },
		]);
		expect(fake.state.callCount).toBe(0);
	} finally {
		client.close();
		host.stop();
	}
});

test("terminal native child context remains inspectable but never grants child writes or standalone identity adoption", async () => {
	const { app, fake, invocation } = await fixture();
	fake.setResponses([fauxAssistantMessage("Recorded child response")]);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const task = await app.startTask(invocation);
		const detail = await eventually(
			() => client.call("task.read", { id: task }),
			(value) => value.native?.status === "terminal",
		);
		const child = detail.metadata.conversationId;
		if (typeof child !== "number" || !Number.isSafeInteger(child))
			throw new Error("Native child missing");
		const reads = fake.state.callCount;
		const observed = await client.call("session.context", { id: child });
		expect(observed.id).toBe(child);
		expect(
			observed.messages.some((message) =>
				JSON.stringify(message.content).includes("Recorded child response"),
			),
		).toBe(true);
		await expect(
			client.call("session.send", {
				id: child,
				content: "Not admitted",
				requestId: "refused-context-child",
			}),
		).rejects.toThrow("Native operation refused");
		const aliased = { id: "standalone-opaque-uuid" };
		// Intentionally malformed boundary input, not a local target conversion.
		await expect(
			client.call("session.context", aliased as unknown as { id: number }),
		).rejects.toThrow("Native operation refused");
		expect(fake.state.callCount).toBe(reads);
	} finally {
		client.close();
		host.stop();
	}
});
