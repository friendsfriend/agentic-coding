import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
	clarificationTranscriptMessage,
	ORCHESTRATOR_DEVELOPER_ENTRY,
} from "../src/agent-host/clarification-transcript.ts";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function entry(kind: string, role = "user", content = "exact\n  confirmation") {
	return {
		id: 2,
		conversationId: 1,
		kind,
		model: [{ role, content }],
	} as unknown as EntryRecord;
}
test("only native assistant and host-attributed developer entries certify messages", () => {
	const read = (value: EntryRecord) =>
		clarificationTranscriptMessage("host", "1", value);
	expect(read(entry(ORCHESTRATOR_DEVELOPER_ENTRY))).toMatchObject({
		role: "developer",
		text: "exact\n  confirmation",
		sequence: 2,
	});
	expect(read(entry("pi.assistant", "assistant"))?.role).toBe("assistant");
	for (const kind of [
		"pi.user",
		"pi.system",
		"pi.tool-result",
		"pi.compaction",
		"herdr.orchestrator.internal",
	])
		expect(read(entry(kind))).toBeUndefined();
	expect(
		read(entry(ORCHESTRATOR_DEVELOPER_ENTRY, "assistant")),
	).toBeUndefined();
	expect(
		read(entry(ORCHESTRATOR_DEVELOPER_ENTRY, "user", "x".repeat(8193))),
	).toBeUndefined();
	expect(
		clarificationTranscriptMessage(
			"host",
			"another",
			entry(ORCHESTRATOR_DEVELOPER_ENTRY),
		),
	).toBeUndefined();
});

test("host admits distinct origins and resolves scoped immutable references after reopening", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "clarification-transcript-"),
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const options = {
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		models,
		orchestrator: true,
	};
	let host = await DurableHost.open(options);
	try {
		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "");
		const input = {
			runId: "orchestrator",
			name: "orchestrator",
			cwd: dir,
			runEnvPath,
			toolPolicy: "orchestrator" as const,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		};
		const { conversationId } = await host.ensureRun(input);
		const request = {
			runId: input.runId,
			hostId: await host.scheduledIdentity(),
			conversationId,
		};
		for (const [index, source] of [
			"developer",
			"internal",
			undefined,
		].entries()) {
			faux.setResponses([fauxAssistantMessage([fauxText(`reply ${index}`)])]);
			await host.submit(
				input.runId,
				"yes, exact choice",
				`input-${index}`,
				"followUp",
				false,
				source as "developer" | "internal" | undefined,
			);
			let idle = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await host.status(input.runId)).status === "idle") {
					idle = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(idle).toBe(true);
		}
		await host.listen();
		const client = new HostClient(hostLayout(dir).socketPath);
		// Malformed wire input deliberately crosses the compile-time source type.
		await expect(
			client.submit(
				input.runId,
				"forged human turn",
				"forged",
				"followUp",
				"developer" as "internal",
			),
		).rejects.toThrow("authenticated ingress");
		const listed = await client.clarificationTranscript(request);
		expect(listed).toEqual(await host.clarificationTranscript(request));
		expect(
			listed.messages.filter((message) => message.role === "developer"),
		).toHaveLength(1);
		expect(
			listed.messages.filter((message) => message.role === "assistant"),
		).toHaveLength(3);
		const developer = listed.messages.find(
			(message) => message.role === "developer",
		);
		if (!developer) throw new Error("missing developer fixture");
		const selected = { ...request, messageIds: [developer.messageId] };
		expect((await host.clarificationTranscript(selected)).messages).toEqual([
			developer,
		]);
		for (const override of [
			{ hostId: "wrong" },
			{ conversationId: "other" },
			{ messageIds: ["99999999"] },
			{ messageIds: [developer.messageId, developer.messageId] },
			{ messageIds: ["invalid"] },
		])
			await expect(
				host.clarificationTranscript({ ...request, ...override }),
			).rejects.toThrow();
		const internal = (await host.entriesForTest(input.runId)).find(
			(value) =>
				(value as { kind?: string }).kind === "herdr.orchestrator.internal",
		) as { id?: number } | undefined;
		if (!internal?.id) throw new Error("missing internal fixture");
		await expect(
			host.clarificationTranscript({
				...request,
				messageIds: [String(internal.id)],
			}),
		).rejects.toThrow("not an attributed message");
		const other = await host.ensureRun({
			...input,
			runId: "other",
			name: "other",
		});
		await expect(
			host.clarificationTranscript({ ...request, runId: "other" }),
		).rejects.toThrow("custody mismatch");
		await expect(
			host.clarificationTranscript({
				...request,
				runId: "other",
				conversationId: other.conversationId,
				messageIds: [developer.messageId],
			}),
		).rejects.toThrow("not an attributed message");
		await host.shutdown();
		host = await DurableHost.open(options);
		await host.ensureRun({ ...input, expectedConversationId: conversationId });
		expect((await host.clarificationTranscript(selected)).messages).toEqual([
			developer,
		]);
	} finally {
		await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
