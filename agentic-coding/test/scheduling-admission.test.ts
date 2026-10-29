import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { schedulingDigest } from "../src/agent-host/scheduled-admission.ts";

for (const phase of ["reserved", "queued"] as const)
	test(`native ${phase} wake-up recovers across reopen before its scheduled answer`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-pending-")),
			layout = hostLayout(dir),
			runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "");
		const faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		const open = () =>
			DurableHost.open({ layout, settings: {}, globalAgentDir: dir, models });
		let host = await open();
		const wait = async (condition: () => Promise<boolean>) => {
			for (let i = 0; i < 300; i++) {
				if (await condition()) return;
				await Bun.sleep(10);
			}
			throw new Error("Pending fixture timed out");
		};
		try {
			const input = {
				runId: "pending",
				name: "pending",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default" as const,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			};
			const binding = await host.ensureRun(input);
			const unrelated = await host.ensureRun({
				runId: "unrelated",
				name: "unrelated",
				cwd: dir,
				runEnvPath,
				toolPolicy: "read-only",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});
			if (phase === "queued") {
				faux.setResponses([
					fauxAssistantMessage(
						[
							fauxToolCall("bash", {
								command:
									"while [ ! -f release ]; do sleep 0.02; done; printf controlled-boundary",
							}),
						],
						{ stopReason: "toolUse" },
					),
				]);
				await host.submit(
					"pending",
					"Hold the current tool boundary",
					"held-turn",
				);
				await wait(async () =>
					JSON.stringify(await host.entriesForTest("pending")).includes(
						"while [ ! -f release ]; do sleep 0.02; done; printf controlled-boundary",
					),
				);
			}
			const text =
					"Self-contained queued observation: inspect fixture only; original instruction and due time retained.",
				envelope = {
					occurrenceId: `pending-${phase}`,
					digest: schedulingDigest(text),
					text,
					expectedHostId: await host.scheduledIdentity(),
					expectedConversationId: binding.conversationId,
					runId: "pending",
				};
			await host.scheduledAdmission("reserve", envelope, 1);
			const before =
				phase === "queued"
					? await host.scheduledAdmission("activate", envelope, 1)
					: await host.scheduledAdmission("query", envelope, 1);
			expect(before.state).toBe(phase);
			expect(before.submission?.answerEntryId).toBeUndefined();
			await host.shutdown();
			fs.writeFileSync(path.join(dir, "release"), "release fixture boundary");
			faux.setResponses(
				Array.from({ length: 4 }, () =>
					fauxAssistantMessage([fauxText("Recovered scheduled observation.")]),
				),
			);
			host = await open();
			await host.ensureRun({
				...input,
				expectedConversationId: binding.conversationId,
			});
			await host.ensureRun({
				...input,
				runId: "unrelated",
				name: "unrelated",
				toolPolicy: "read-only",
				expectedConversationId: unrelated.conversationId,
			});
			const restored = await host.scheduledAdmission("reserve", envelope, 2);
			if (phase === "reserved") expect(restored.state).toBe("reserved");
			else expect(restored.submission?.id).toBe(before.submission?.id);
			await host.scheduledAdmission("activate", envelope, 2);
			await wait(
				async () =>
					(await host.scheduledAdmission("query", envelope, 2)).state ===
					"succeeded",
			);
			const after = await host.scheduledAdmission("query", envelope, 2);
			expect(after.result).toBe("Recovered scheduled observation.");
			expect(JSON.stringify(await host.entriesForTest("pending"))).toContain(
				envelope.text,
			);
			expect(after.submission?.conversationId).toBe(binding.conversationId);
			if (phase === "queued")
				expect(after.submission?.id).toBe(before.submission?.id);
			expect(
				(await host.scheduledAdmission("activate", envelope, 3)).submission,
			).toEqual(after.submission);
			expect(
				JSON.stringify(await host.entriesForTest("unrelated")),
			).not.toContain(text);
		} finally {
			fs.writeFileSync(path.join(dir, "release"), "release fixture boundary");
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

test("durable native reservation/activation survives lost acknowledgement and host reopen", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-native-")),
		layout = hostLayout(dir),
		runEnvPath = path.join(dir, "run.env");
	fs.writeFileSync(runEnvPath, "");
	const hosts: DurableHost[] = [];
	async function open() {
		const faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxText("fixture report complete")]),
		]);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			models,
		});
		hosts.push(host);
		return { host, model: `${faux.getModel().provider}/${faux.getModel().id}` };
	}
	try {
		const { host: a, model } = await open();
		const binding = await a.ensureRun({
			runId: "fixture",
			name: "fixture",
			cwd: dir,
			runEnvPath,
			toolPolicy: "read-only",
			model,
		});
		const text = JSON.stringify({
			originalInstruction: "recheck fixture later",
			reason: "restart proof",
			due: "2026-01-01T00:00:00Z",
		});
		const envelope = {
			occurrenceId: "fixture-occurrence",
			digest: schedulingDigest(text),
			text,
			expectedHostId: await a.scheduledIdentity(),
			expectedConversationId: binding.conversationId,
			runId: "fixture",
		};
		expect((await a.scheduledAdmission("reserve", envelope, 1)).state).toBe(
			"reserved",
		);
		expect((await a.status("fixture")).status).toBe("idle");
		const first = await a.scheduledAdmission("activate", envelope, 1);
		for (
			let i = 0;
			i < 100 && (await a.status("fixture")).status !== "idle";
			i++
		)
			await Bun.sleep(10);
		await a.shutdown();
		hosts.splice(hosts.indexOf(a), 1);
		const { host: b } = await open();
		const before = await b.scheduledAdmission("query", envelope, 1);
		const repeated = await b.scheduledAdmission("activate", envelope, 2);
		expect(first.submission?.id).toBeDefined();
		expect(before.submission?.id).toBe(first.submission?.id);
		expect(repeated.submission).toEqual(before.submission);
		expect(before.result).toBe("fixture report complete");
		expect(repeated.result).toBe(before.result);
		expect(repeated.state).toBe("succeeded");
		await expect(
			b.scheduledAdmission(
				"reserve",
				{ ...envelope, text: "changed", digest: schedulingDigest("changed") },
				2,
			),
		).rejects.toThrow();
		await expect(
			b.scheduledAdmission(
				"activate",
				{ ...envelope, expectedConversationId: "999" },
				2,
			),
		).rejects.toThrow();
		await expect(
			b.scheduledAdmission(
				"activate",
				{ ...envelope, expectedHostId: "other-host" },
				2,
			),
		).rejects.toThrow();
	} finally {
		for (const host of hosts) await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("busy wake-up survives an in-flight compaction and host restart without interrupting its tool", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-busy-"));
	const layout = hostLayout(dir),
		runEnvPath = path.join(dir, "run.env");
	fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='busy'\n");
	const faux = fauxProvider({
			models: [{ id: "small", contextWindow: 100_000 }],
		}),
		models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel("small");
	if (!model) throw new Error("Missing fixture model");
	const open = () =>
		DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			models,
			compaction: () => ({
				enabled: false,
				ceilingTokens: 0,
				backgroundTokens: 0,
			}),
		});
	let host = await open(),
		releaseSummary = () => {};
	const wait = async (condition: () => Promise<boolean>) => {
		for (let i = 0; i < 300; i++) {
			if (await condition()) return;
			await Bun.sleep(10);
		}
		throw new Error("Native fixture condition timed out");
	};
	try {
		const binding = await host.ensureRun({
			runId: "busy",
			name: "busy",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${model.provider}/${model.id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxText("old reply")]),
			fauxAssistantMessage([fauxText("recent reply")]),
		]);
		await host.submit("busy", "old history ".repeat(30000), "seed-1");
		await wait(async () => (await host.status("busy")).status === "idle");
		await host.submit("busy", "recent tail", "seed-2");
		await wait(async () => (await host.status("busy")).status === "idle");
		const summaryReady = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		faux.setResponses([
			async () => {
				await summaryReady;
				return fauxAssistantMessage([
					fauxText("Safe fixture compaction summary."),
				]);
			},
		]);
		const compaction = await host.compactRun("busy");
		expect(compaction.status).toBe("started");
		// Admit while a real summary is in flight: its older context selection must
		// not erase the new native reservation, inbox receipt, or exact answer.
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "sleep 0.4; printf tool-finished" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("first complete")]),
			fauxAssistantMessage([fauxText("reminder complete")]),
		]);
		await host.submit("busy", "fixture long tool", "first");
		await wait(async () =>
			JSON.stringify(await host.entriesForTest("busy")).includes(
				"sleep 0.4; printf tool-finished",
			),
		);
		const text = "Scheduled observation only: report fixture result.";
		const envelope = {
			occurrenceId: "busy-occurrence",
			digest: schedulingDigest(text),
			text,
			expectedHostId: await host.scheduledIdentity(),
			expectedConversationId: binding.conversationId,
			runId: "busy",
		};
		await host.scheduledAdmission("reserve", envelope, 1);
		const queued = await host.scheduledAdmission("activate", envelope, 1);
		expect(queued.state).toBe("queued");
		await wait(
			async () =>
				(await host.scheduledAdmission("query", envelope, 1)).state ===
				"succeeded",
		);
		const completed = await host.scheduledAdmission("query", envelope, 1);
		expect(completed.result).toBe("reminder complete");
		expect(completed.submission?.answerEntryId).toBeDefined();
		releaseSummary();
		await wait(
			async () => (await host.liveCompactionCountForTest("busy")) === 0,
		);
		expect(JSON.stringify(await host.entriesForTest("busy"))).toContain(
			"Safe fixture compaction summary.",
		);
		await host.shutdown();
		host = await open();
		const recovered = await host.scheduledAdmission("activate", envelope, 2);
		expect(recovered.state).toBe("succeeded");
		expect(recovered.submission).toEqual(completed.submission);
		expect(recovered.result).toBe("reminder complete");
		if (process.env.SCHEDULING_FIXTURE_EVIDENCE)
			fs.appendFileSync(
				process.env.SCHEDULING_FIXTURE_EVIDENCE,
				`${JSON.stringify({
					fixture: "wake-up",
					identity: await host.scheduledIdentity(),
					completed,
					afterCompactionAndRestart: recovered,
					compaction,
				})}\n`,
			);
	} finally {
		releaseSummary();
		await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
