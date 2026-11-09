import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated context reads do not place a supplied native inbox, resume generation, adopt a partial or create a model request", async () => {
	const { app, fake } = await fixture();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	fake.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage("Released fixture response");
		},
		...Array.from({ length: 27 }, (_, index) =>
			fauxAssistantMessage(`Recorded follow-up response ${index}`),
		),
	]);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		const id = Number(app.home.id);
		await client.call("session.send", {
			id,
			content: "Active input before fixture gate",
			requestId: "context-active",
		});
		await eventually(
			() => client.call("session.read", { id }),
			(value) =>
				value.progress.generation !== null && fake.state.callCount === 1,
		);
		for (let index = 0; index < 27; index++)
			await client.call("session.send", {
				id,
				content: `Queued-${index} 😀e\u0301\r\n`,
				requestId: `context-queued-${index}`,
			});
		const supplied = await client.call("session.read", { id });
		expect(supplied.progress.inbox).toHaveLength(27);
		expect(new Set(supplied.progress.inbox.map((item) => item.id)).size).toBe(
			27,
		);
		expect(
			supplied.progress.inbox.every((item) => item.mode === "followUp"),
		).toBe(true);
		expect(supplied.progress.run).not.toBeNull();
		expect(supplied.progress.generation?.attempt).toBe(1);
		const observed = await client.call("session.context", { id });
		expect(JSON.stringify(observed.messages)).toContain(
			"Active input before fixture gate",
		);
		expect(JSON.stringify(observed.messages)).not.toContain("Queued-");
		expect(observed.contributions).toHaveLength(observed.entries.length);
		expect(await client.call("session.context", { id })).toEqual(observed);
		const after = await client.call("session.read", { id });
		expect(after.progress.inbox).toEqual(supplied.progress.inbox);
		expect(after.progress.run).toEqual(supplied.progress.run);
		expect(after.progress.generation).toEqual(supplied.progress.generation);
		expect(fake.state.callCount).toBe(1);
		release();
		const settled = await eventually(
			() => client.call("session.read", { id }),
			(value) =>
				value.progress.run === null && value.progress.inbox.length === 0,
		);
		expect(settled.progress.generation).toBeNull();
		expect(
			JSON.stringify((await client.call("session.context", { id })).messages),
		).toContain("Queued-26");
	} finally {
		release();
		client.close();
		host.stop();
	}
});
