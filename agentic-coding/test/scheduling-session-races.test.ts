import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { schedulingDigest } from "../src/agent-host/scheduled-admission.ts";
import { sessionCommand } from "../src/agent-host/session-command.ts";
import {
	bindDurableSession,
	createDurableSession,
	durableSessionOwner,
	initializeDurableSessions,
	readDurableSessionRegistry,
	requireDurableSession,
} from "../src/pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../src/pi-durable-state.ts";
import { dailyDigestProposal } from "../src/scheduling/daily-digest-setup.ts";
import { workflowlessSessionAdapter } from "../src/server/scheduling/session.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

for (const race of ["abort", "shutdown", "delete"] as const)
	test(`native scheduled activation is linearized with ${race} before enqueue`, async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "session-races-")),
		);
		const keys = [
				"HOME",
				"AGENTIC_CODING_CONFIG_DIR",
				"PI_CODING_AGENT_DIR",
				"HERDR_WIKI_DIR",
			] as const,
			previous = keys.map((key) => [key, process.env[key]] as const);
		let host: DurableHost | undefined,
			store: SchedulingStore | undefined,
			release = () => {},
			releaseIdentity = () => {};
		const spies: { mockRestore(): void }[] = [];
		try {
			for (const key of keys) process.env[key] = root;
			fs.writeFileSync(
				path.join(root, "settings.json"),
				JSON.stringify({ defaultTools: ["+codemode"] }),
			);
			const runtimeDir = piDurableRuntimeDir(root),
				owner = durableSessionOwner(),
				faux = fauxProvider(),
				models = createModels();
			models.setProvider(faux.provider);
			initializeDurableSessions(runtimeDir, root, owner);
			const record = createDurableSession(runtimeDir, {
				operationId: "fixture",
				name: "Daily task digest",
				owner,
				cwd: root,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				thinking: "off",
				toolPolicy: "collection",
			});
			const nativeOptions = {
				layout: hostLayout(runtimeDir),
				globalAgentDir: root,
				session: true,
				settings: { localPiTools: { enabled: false } },
				models,
			};
			const native = await DurableHost.open(nativeOptions);
			host = native;
			const env = path.join(root, "run.env");
			fs.writeFileSync(env, "");
			const opened = await native.ensureRun({
				runId: record.runId,
				name: record.runId,
				cwd: root,
				runEnvPath: env,
				toolPolicy: "collection",
				model: record.model,
			});
			const hostId = await native.scheduledIdentity();
			bindDurableSession(runtimeDir, record.id, owner, {
				hostId,
				conversationId: opened.conversationId,
			});
			const text = "Synthetic scheduled observation",
				envelope = {
					occurrenceId: "race",
					text,
					digest: schedulingDigest(text),
					runId: record.runId,
					expectedHostId: hostId,
					expectedConversationId: opened.conversationId,
				};
			faux.setResponses([
				fauxAssistantMessage([fauxText("Retained scheduled answer")]),
			]);
			if (race === "abort") {
				await native.scheduledAdmission("reserve", envelope, 1);
				// Gate the existing stop boundary, not the queue under test. Native abort
				// still runs; removing scheduled serialization makes activation settle here.
				const controls = native as unknown as {
					stopConversation(runId: string, blocked: boolean): Promise<void>;
				};
				const original = controls.stopConversation.bind(native);
				let enter = () => {};
				const entered = new Promise<void>((resolve) => {
						enter = resolve;
					}),
					gate = new Promise<void>((resolve) => {
						release = resolve;
					});
				const stopping = spyOn(controls, "stopConversation").mockImplementation(
					async (id, blocked) => {
						enter();
						await gate;
						return original(id, blocked);
					},
				);
				spies.push(stopping);
				const aborting = native.abort(record.runId);
				await entered;
				let settled = false;
				const activating = native
					.scheduledAdmission("activate", envelope, 1)
					.then((value) => {
						settled = true;
						return value;
					});
				await Bun.sleep(30);
				expect(settled).toBe(false);
				expect(
					(await native.scheduledAdmission("query", envelope, 1)).state,
				).toBe("reserved");
				release();
				await aborting;
				await activating;
				let receipt = await native.scheduledAdmission("query", envelope, 1);
				for (let i = 0; i < 100 && receipt.state !== "succeeded"; i++) {
					await Bun.sleep(10);
					receipt = await native.scheduledAdmission("query", envelope, 1);
				}
				expect(receipt.state).toBe("succeeded");
				expect(receipt.result).toContain("Retained scheduled answer");
				expect(receipt.submission?.answerEntryId).toBeDefined();
			} else if (race === "shutdown") {
				await native.scheduledAdmission("reserve", envelope, 1);
				let enterIdentity = () => {},
					enterStop = () => {};
				const enteredIdentity = new Promise<void>((resolve) => {
						enterIdentity = resolve;
					}),
					identityGate = new Promise<void>((resolve) => {
						releaseIdentity = resolve;
					}),
					enteredStop = new Promise<void>((resolve) => {
						enterStop = resolve;
					}),
					stopGate = new Promise<void>((resolve) => {
						release = resolve;
					});
				const identity = native.scheduledIdentity.bind(native);
				spies.push(
					spyOn(native, "scheduledIdentity").mockImplementation(async () => {
						enterIdentity();
						await identityGate;
						return identity();
					}),
				);
				const controls = native as unknown as {
						stopConversation(runId: string, blocked: boolean): Promise<void>;
					},
					original = controls.stopConversation.bind(native);
				spies.push(
					spyOn(controls, "stopConversation").mockImplementation(
						async (id, blocked) => {
							enterStop();
							await stopGate;
							return original(id, blocked);
						},
					),
				);
				let settled = false;
				const activating = native
					.scheduledAdmission("activate", envelope, 1)
					.then(
						(value) => {
							settled = true;
							return value;
						},
						(error: unknown) => {
							settled = true;
							return error;
						},
					);
				await enteredIdentity;
				const closing = native.shutdown();
				await enteredStop;
				releaseIdentity();
				await Bun.sleep(30);
				expect(settled).toBe(false);
				release();
				await closing;
				expect(await activating).toMatchObject({
					message: "agent host is shutting down",
				});
				expect(faux.state.callCount).toBe(0);
			} else {
				const registry = readDurableSessionRegistry(runtimeDir);
				if (!registry) throw new Error("fixture registry missing");
				const bound = requireDurableSession(registry, record.id, owner),
					proposal = dailyDigestProposal(bound, "main");
				store = SchedulingStore.open(path.join(root, "scheduler"));
				const due = Date.parse("2026-03-30T07:00:00Z"),
					job = store.createJob(proposal.job, 0);
				store.createSchedule(
					{
						...proposal.schedule,
						jobId: job.id,
						timing: {
							kind: "once",
							at: new Date(due).toISOString(),
							timezone: "UTC",
						},
					},
					0,
				);
				const pending = store.reconcileDue(due)[0];
				const occurrence = pending ? store.claim(pending.id, due) : undefined;
				if (!occurrence) throw new Error("fixture claim missing");
				const result = {
					runId: record.runId,
					sessionId: record.id,
					hostSocket: "in-process",
				};
				const revoke = spyOn(
					HostClient.prototype,
					"revokeSession",
				).mockImplementation((...args) => native.revokeSession(...args));
				spies.push(revoke);
				let deleting = false;
				const adapter = workflowlessSessionAdapter(root, {
					models: async () => [record.model ?? ""],
					validateBase: async () => {},
					open: async () => {
						if (deleting)
							expect(
								await sessionCommand(["delete", record.id], {
									configDir: root,
									open: async () => result,
									print: () => {},
								}),
							).toBe(0);
						return result;
					},
					client: () => ({
						scheduledAdmission: async (request) => ({
							type: "scheduledAdmission",
							receipt: await native.scheduledAdmission(
								request.operation,
								request.envelope,
								request.fence,
							),
						}),
					}),
				});
				const reserved = await adapter.reserve(occurrence);
				deleting = true;
				await expect(
					adapter.activate({ ...occurrence, receipt: reserved }),
				).rejects.toThrow("no replacement");
				expect(
					readDurableSessionRegistry(runtimeDir)?.sessions.find(
						(value) => value.id === record.id,
					)?.deletedAt,
				).toBeDefined();
				expect(faux.state.callCount).toBe(0);
				expect(
					JSON.stringify(await native.entriesForTest(record.runId)),
				).not.toContain("Scheduled read-only daily task digest");
				// The revocation is native durable authority, not a last-second metadata read.
				await expect(
					native.scheduledAdmission("activate", envelope, 1),
				).rejects.toThrow("revoked");
				await native.shutdown();
				const restarted = await DurableHost.open(nativeOptions);
				host = restarted;
				await restarted.ensureRun({
					runId: record.runId,
					name: record.runId,
					cwd: root,
					model: record.model,
					toolPolicy: "collection",
					runEnvPath: env,
					expectedConversationId: opened.conversationId,
				});
				await expect(
					restarted.scheduledAdmission("activate", envelope, 1),
				).rejects.toThrow("revoked");
				expect(faux.state.callCount).toBe(0);
			}
		} finally {
			release();
			releaseIdentity();
			for (const spy of spies.reverse()) spy.mockRestore();
			try {
				await host?.shutdown();
				store?.close();
			} finally {
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});
