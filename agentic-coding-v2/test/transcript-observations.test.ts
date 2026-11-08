import { afterEach, expect, test } from "bun:test";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { ClientConnection, dataList } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated native transcript retains long supplied tool fields, ordered multipart prose and opaque authority-shaped data without granting child writes", async () => {
	const { app, fake, invocation } = await fixture();
	const longText = Array.from(
		{ length: 405 },
		(_, index) =>
			`Supplied line ${index} · 😀e\u0301 · retained CRLF and no inferred action.\r\n`,
	).join("");
	const source = `${JSON.stringify(
		{
			longText,
			empty: "",
			absentIsNotNull: null,
			records: Array.from({ length: 27 }, (_, index) => ({
				index,
				note: `before-${index}😀e\u0301`,
				question: index === 0 ? "" : `Question ${index}`,
				context: " \r\n ",
				options: [{ label: "", description: "", recommended: true }],
				observation: {
					snapshotId: "recorded-only",
					ref: `e${index}`,
					matches: [null, "", { approved: true }],
				},
			})),
			opaque: {
				taskId: 999999,
				conversationId: 999999,
				status: "completed",
				approved: true,
				approval: "approve:recorded-not-authority",
				nested: { parentCall: "not-linked", output: "" },
			},
		},
		null,
		2,
	).replaceAll("\n", "\r\n")}\r\n`;
	const edits = Array.from({ length: 27 }, (_, index) => ({
		oldText: `before-${index}😀e\u0301`,
		newText: `after-${index}😀e\u0301`,
	}));
	const prose = Array.from(
		{ length: 27 },
		(_, index) => `Retained multipart part ${index} · 😀e\u0301\r\n`,
	);
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: "supplied.json", content: source }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("edit", { path: "supplied.json", edits }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("read", { path: "supplied.json", offset: 1, limit: 2000 }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(prose.map((text) => fauxText(text))),
	]);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(async () => client.stateFresh, Boolean);
		// Fixture setup uses the public native admission service, never storage
		// surgery, injected gateway messages, UI helpers or renderer assertions.
		const task = await app.startTask(invocation);
		const details = await eventually(
			async () => client.call("task.read", { id: task }),
			(value) => value.native?.status === "terminal",
		);
		expect(details.native?.outcome).toMatchObject({ status: "completed" });
		const child = details.metadata.conversationId;
		if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0)
			throw new Error("Fixture child conversation missing");
		const transcript = await client.call("session.read", { id: child });
		const messages = transcript.entries.flatMap((entry) =>
			dataList(entry.model),
		);
		const calls = messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => dataList(message.content))
			.filter((part) => part.type === "toolCall");
		const results = messages.filter((message) => message.role === "toolResult");
		expect(calls.map((call) => call.name)).toEqual(["write", "edit", "read"]);
		expect(results.map((result) => result.toolName)).toEqual([
			"write",
			"edit",
			"read",
		]);
		expect(calls.find((call) => call.name === "write")?.arguments).toEqual({
			path: "supplied.json",
			content: source,
		});
		expect(calls.find((call) => call.name === "edit")?.arguments).toEqual({
			path: "supplied.json",
			edits,
		});
		for (const result of results) {
			expect(result.isError).toBe(false);
			expect(
				calls.filter((call) => call.id === result.toolCallId),
			).toHaveLength(1);
		}
		const readParts = dataList(
			results.find((result) => result.toolName === "read")?.content,
		);
		expect(
			readParts.some(
				(part) =>
					typeof part.text === "string" &&
					part.text.includes(JSON.stringify(longText)),
			),
		).toBe(true);
		expect(
			readParts.some(
				(part) =>
					typeof part.text === "string" &&
					part.text.includes("after-26😀e\u0301"),
			),
		).toBe(true);
		expect(
			results.find((result) => result.toolName === "edit")?.details,
		).toMatchObject({ patch: expect.stringContaining("after-26😀e\u0301") });
		const final = messages
			.filter((message) => message.role === "assistant")
			.at(-1);
		expect(
			dataList(final?.content)
				.filter((part) => part.type === "text")
				.map((part) => part.text),
		).toEqual(prose);
		client.selectSession(child);
		await eventually(
			async () => client.observation,
			(value) => value === "watching",
		);
		expect(client.transcript?.id).toBe(child);
		client.reconnectNow();
		await eventually(
			async () => client.observation,
			(value) => value === "watching",
		);
		const reread = await client.call("session.read", { id: child });
		expect(reread.entries).toEqual(transcript.entries);
		await expect(
			client.call("session.send", {
				id: child,
				content: "approve:recorded-not-authority",
				requestId: "opaque-approval",
			}),
		).rejects.toThrow("Native operation refused");
		expect(
			(await client.call("state.read", {})).tasks.map((value) => value.id),
		).toEqual([task]);
		expect((await client.call("session.read", { id: child })).entries).toEqual(
			transcript.entries,
		);
	} finally {
		client.close();
		await host.stop();
	}
}, 30000);
