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
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import {
	orchestratorRuntimeDir,
	submitOrchestratorDeveloperInput,
} from "../src/agent-host/orchestrator-session.ts";
import type {
	DeveloperDialogueRecord,
	WorkflowView,
} from "../src/contracts/workflow.ts";
import {
	orchestratorConversationTokenFor,
	orchestratorDeveloperInputProofFor,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import {
	clarificationSources,
	resolveClarificationAuthority,
} from "../src/server/clarification.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	clarificationDigest,
	renderClarificationProposal,
} from "../src/workflow/runtime/clarification-actions.ts";

test("operator-attested Home input gets durable human provenance; caller origin claims do not", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "developer-input-"));
	const server = await startWorkflowServer({
		configDir: dir,
		operations: {} as ServerOperations,
	});
	const question: DeveloperDialogueRecord = {
		id: "native-question",
		workflowId: "workflow",
		runId: "worker",
		stepId: "core.implementation",
		role: "worker",
		description: "Which exact answer?",
		options: [],
		targetRole: "orchestrator",
		status: "pending",
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	const responses = [
		{
			questionId: question.id,
			kind: "custom" as const,
			value: "The agreed answer",
		},
	];
	const layout = hostLayout(orchestratorRuntimeDir(dir));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const options = {
		layout,
		settings: {},
		globalAgentDir: dir,
		models,
		orchestrator: true,
		developerInputVerifierUrl: server.url,
	};
	let host = await DurableHost.open(options);
	let stopped = false;
	try {
		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "");
		const run = {
			runId: "home",
			name: "home",
			cwd: dir,
			runEnvPath,
			toolPolicy: "orchestrator" as const,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		};
		const { conversationId } = await host.ensureRun(run);
		const hostId = await host.scheduledIdentity();
		const scopedToken = orchestratorConversationTokenFor(server.token, {
			hostId,
			conversationId,
		});
		fs.writeFileSync(
			runEnvPath,
			`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${scopedToken}'\n`,
		);
		await host.ensureRun({ ...run, expectedConversationId: conversationId });
		await host.listen();
		const client = new HostClient(layout.socketPath);
		const input: import("../src/contracts/orchestrator-input.ts").OrchestratorDeveloperInput =
			{
				hostId,
				conversationId,
				runId: run.runId,
				requestId: "exact-human-request",
				text: "Use the exact multiline\n  candidate, confirmed.",
				whenBusy: "steer" as const,
				expiresAt: Date.now() + 60_000,
			};
		const proof = orchestratorDeveloperInputProofFor(server.token, input);
		const verify = (token: string, value = input, signature = proof) =>
			fetch(`${server.url}/api/v1/orchestrator/input/verify`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ input: value, proof: signature }),
			});
		expect((await verify(scopedToken)).status).toBe(200);
		for (const token of [
			server.token,
			orchestratorTokenFor(server.token),
			orchestratorConversationTokenFor(server.token, {
				hostId,
				conversationId: "other",
			}),
		])
			expect((await verify(token)).status).toBe(403);
		for (const changed of [
			{ text: "different" },
			{ requestId: "replay-as-new" },
			{ runId: "other" },
			{ hostId: "other" },
			{ conversationId: "other" },
			{ expiresAt: Date.now() - 1 },
			{ whenBusy: "followUp" as const },
		])
			expect((await verify(scopedToken, { ...input, ...changed })).status).toBe(
				403,
			);
		for (const key of [scopedToken, orchestratorTokenFor(server.token)])
			expect(
				(
					await verify(
						scopedToken,
						input,
						orchestratorDeveloperInputProofFor(key, input),
					)
				).status,
			).toBe(403);
		await expect(
			client.submitDeveloperInput({ ...input, text: "forged" }, proof),
		).rejects.toThrow("proof refused");
		expect(
			(
				await client.clarificationTranscript({
					hostId,
					conversationId,
					runId: run.runId,
				})
			).messages,
		).toEqual([]);
		faux.setResponses([
			fauxAssistantMessage([
				fauxText(renderClarificationProposal([question], responses, 1)),
			]),
		]);
		await client.submitDeveloperInput(input, proof);
		for (
			let i = 0;
			i < 100 && (await host.status(run.runId)).status !== "idle";
			i++
		)
			await Bun.sleep(10);
		expect((await host.status(run.runId)).status).toBe("idle");
		const transcript = { hostId, conversationId, runId: run.runId };
		const messages = (await client.clarificationTranscript(transcript))
			.messages;
		expect(
			messages
				.filter((message) => message.role === "developer")
				.map((message) => message.text),
		).toEqual([input.text]);
		await client.submitDeveloperInput(input, proof);
		expect((await client.clarificationTranscript(transcript)).messages).toEqual(
			messages,
		);
		const humanId = messages.find(
			(message) => message.role === "developer",
		)?.messageId;
		if (!humanId) throw new Error("missing native developer reference");
		const claim = {
			...transcript,
			confirmationMessageId: humanId,
			binding: "a".repeat(64),
		};
		await client.claimClarification(claim);
		await client.claimClarification(claim);
		await expect(
			client.claimClarification({ ...claim, binding: "b".repeat(64) }),
		).rejects.toThrow("another candidate");
		// Run recovery JSON/env is not allowed to select a verifier willing to
		// attest caller-authored human turns.
		fs.writeFileSync(
			runEnvPath,
			`${ORCHESTRATOR_URL_ENV}='http://127.0.0.1:9'\n${ORCHESTRATOR_TOKEN_ENV}='${scopedToken}'\n`,
		);
		await host.ensureRun({ ...run, expectedConversationId: conversationId });
		await expect(client.submitDeveloperInput(input, proof)).rejects.toThrow(
			"verifier unavailable",
		);
		fs.writeFileSync(
			runEnvPath,
			`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${scopedToken}'\n`,
		);
		await host.ensureRun({ ...run, expectedConversationId: conversationId });
		expect((await client.clarificationTranscript(transcript)).messages).toEqual(
			messages,
		);
		// The actual Home submit helper signs the same bounded envelope, never a
		// reusable role assertion, and does not expose the operator key to host.
		faux.setResponses([
			fauxAssistantMessage([fauxText("Second ordinary reply")]),
		]);
		await submitOrchestratorDeveloperInput(
			client,
			{ ...run, hostSocket: layout.socketPath, conversationId },
			"Yes, relay the exact proposed answer.",
			"human-two",
			"steer",
			server.token,
		);
		for (
			let i = 0;
			i < 100 && (await host.status(run.runId)).status !== "idle";
			i++
		)
			await Bun.sleep(10);
		const beforeRestart = (await client.clarificationTranscript(transcript))
			.messages;
		expect(
			beforeRestart.filter((message) => message.role === "developer"),
		).toHaveLength(2);
		const nativeProposal = beforeRestart.find(
			(message) => message.role === "assistant",
		);
		const nativeConfirmation = beforeRestart
			.filter((message) => message.role === "developer")
			.at(-1);
		if (!nativeProposal || !nativeConfirmation)
			throw new Error("native proposal/confirmation missing");
		const attached = { hostId, conversationId, epoch: 1 };
		question.clarification = {
			attachment: attached,
			delivery: { id: "delivery", status: "pending" },
			candidate: {
				version: 1,
				responses,
				digest: clarificationDigest([
					question.workflowId,
					attached,
					question.runId,
					1,
					responses,
				]),
				proposal: {
					messageId: nativeProposal.messageId,
					sequence: nativeProposal.sequence,
				},
			},
		};
		const view = {
			workflowId: question.workflowId,
			repository: dir,
			task: "An agreed task",
			developerDialogue: [question],
			clarificationAttachment: attached,
		} as WorkflowView;
		const mutation = {
			epoch: 1,
			questionId: question.id,
			askingRunId: question.runId,
			homeRunId: run.runId,
		};
		const request = {
			actionId: "clarification.confirm",
			input: {
				...mutation,
				version: 1,
				confirmationMessageId: nativeConfirmation.messageId,
				receipt: "native-receipt",
				messages: [{ role: "developer", text: "forged caller metadata" }],
			},
			view,
			principal: "orchestrator" as const,
			identity: { hostId, conversationId },
			configDir: dir,
		};
		const verified = await resolveClarificationAuthority(request);
		expect(verified.messages.map((message) => message.role)).toEqual([
			"assistant",
			"developer",
		]);
		expect(verified.messages.at(-1)?.text).toBe(
			"Yes, relay the exact proposed answer.",
		);
		await resolveClarificationAuthority(request);
		await expect(
			resolveClarificationAuthority({ ...request, identity: undefined }),
		).rejects.toThrow("another or unattached");
		await expect(
			resolveClarificationAuthority({
				...request,
				identity: { hostId, conversationId: "foreign" },
			}),
		).rejects.toThrow("another or unattached");
		const grounded = await resolveClarificationAuthority({
			...request,
			actionId: "clarification.grounded",
			input: {
				...mutation,
				responses,
				rationale: "Task",
				receipt: "grounded",
				sources: clarificationSources(view),
			},
		});
		expect(grounded.sources).toEqual([
			{ kind: "task", id: "task", digest: clarificationDigest(view.task) },
		]);
		await server.stop();
		stopped = true;
		const unavailable = {
			...input,
			requestId: "unavailable",
			text: "must not become evidence",
		};
		await expect(
			client.submitDeveloperInput(
				unavailable,
				orchestratorDeveloperInputProofFor(server.token, unavailable),
			),
		).rejects.toThrow();
		expect((await client.clarificationTranscript(transcript)).messages).toEqual(
			beforeRestart,
		);
		await host.shutdown();
		host = await DurableHost.open(options);
		await host.ensureRun({ ...run, expectedConversationId: conversationId });
		expect((await host.clarificationTranscript(transcript)).messages).toEqual(
			beforeRestart,
		);
		await host.claimClarification(claim);
		await expect(
			host.claimClarification({ ...claim, binding: "b".repeat(64) }),
		).rejects.toThrow("another candidate");
	} finally {
		await host.shutdown();
		if (!stopped) await server.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
