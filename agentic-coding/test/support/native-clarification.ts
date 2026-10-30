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
import { HostClient } from "../../src/agent-host/client.ts";
import { DurableHost } from "../../src/agent-host/host.ts";
import { hostLayout } from "../../src/agent-host/layout.ts";
import {
	orchestratorRuntimeDir,
	submitOrchestratorDeveloperInput,
} from "../../src/agent-host/orchestrator-session.ts";
import type { ResolvedProfile } from "../../src/contracts/workflow.ts";
import { orchestratorConversationTokenFor } from "../../src/server/auth.ts";
import type { ServerOperations } from "../../src/server/handlers.ts";
import { startWorkflowServer } from "../../src/server/lifecycle.ts";
import { registerBuiltins } from "../../src/workflow/definitions.ts";
import { WorkflowEngine } from "../../src/workflow/runtime.ts";
import { createRepoFixture, repoPreset } from "./git-fixture.ts";

/** Real persisted engine + native fake-provider Home + authenticated HTTP. No
 * worker subprocess or provider credential is read: launch completion is a
 * fixture, and continuation is inspected in the normal durable launch outbox. */
export async function nativeClarificationFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-clarification-"));
	const repo = createRepoFixture(path.join(root, "repo"), {
		...repoPreset.readme,
		excludeWorkflowState: true,
	});
	let engine = new WorkflowEngine(registerBuiltins());
	const profile: ResolvedProfile = {
		name: "fake",
		runtime: "pi-durable",
		executable: process.execPath,
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"],
		digest: "fake",
	};
	const started = engine.start({
		repo,
		workflowId: "native",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "Use the agreed A implementation",
		},
		routing: {
			defaultProfile: "fake",
			routes: [{ stepId: "core.implementation", role: "worker", profile }],
		},
	});
	const run = engine.getRun(repo, started.view.runs[0]?.id ?? "");
	const launch = engine
		.claimEffects(repo)
		.find((effect) => effect.kind === "agent.launch");
	if (!launch?.lease || !launch.runToken)
		throw new Error("fixture launch missing");
	const token = launch.runToken;
	engine.dispatch(repo, {
		type: "effect.result",
		effectId: launch.id,
		lease: launch.lease,
		outcome: "complete",
		data: { runtime: "pi-durable", name: "worker", paneId: "fake" },
	});
	let actionAdapter: ServerOperations["action"] | undefined;
	const operations = {
		view: (target: string, id: string) => engine.status(target, id),
		listViews: (target: string) => [engine.status(target, run.workflowId)],
		action: (request, options) =>
			actionAdapter
				? actionAdapter(request, options)
				: engine.dispatch(request.repo, {
						type: "developer.action",
						workflowId: request.workflowId,
						revision: request.revision,
						actionId: request.actionId,
						input: request.input,
						principal: options?.principal,
						...(options?.clarificationAuthority
							? { clarificationAuthority: options.clarificationAuthority }
							: {}),
					}).view,
	} satisfies Pick<ServerOperations, "view" | "listViews" | "action">;
	const server = await startWorkflowServer({
		configDir: root,
		operations: operations as ServerOperations,
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const layout = hostLayout(orchestratorRuntimeDir(root));
	const hostOptions = {
		layout,
		settings: {},
		globalAgentDir: root,
		models,
		orchestrator: true,
		developerInputVerifierUrl: server.url,
	};
	let host = await DurableHost.open(hostOptions);
	const runEnvPath = path.join(root, "home.env");
	fs.writeFileSync(runEnvPath, "");
	const home = {
		runId: "home",
		name: "home",
		cwd: repo,
		runEnvPath,
		toolPolicy: "orchestrator" as const,
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	};
	const { conversationId } = await host.ensureRun(home);
	const hostId = await host.scheduledIdentity();
	const scopedToken = orchestratorConversationTokenFor(server.token, {
		hostId,
		conversationId,
	});
	fs.writeFileSync(
		runEnvPath,
		`AGENTIC_ORCHESTRATOR_URL='${server.url}'\nAGENTIC_ORCHESTRATOR_TOKEN='${scopedToken}'\n`,
	);
	await host.ensureRun({ ...home, expectedConversationId: conversationId });
	await host.listen();
	const client = new HostClient(layout.socketPath);
	const session = {
		runId: home.runId,
		hostSocket: layout.socketPath,
		conversationId,
	};
	const view = () => engine.status(repo, run.workflowId);
	const post = (
		actionId: string,
		input: unknown,
		operator = false,
		workflowId = run.workflowId,
	) =>
		fetch(`${server.url}/api/v1/workflow/action`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${operator ? server.token : scopedToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				repo,
				workflowId,
				revision: engine.status(repo, workflowId).revision,
				actionId,
				input,
			}),
		});
	const attached = await post(
		"clarification.attach",
		{ hostId, conversationId, homeRunId: home.runId },
		true,
	);
	if (!attached.ok)
		throw new Error(`fixture attachment failed: ${await attached.text()}`);
	const messages = async () =>
		(
			await client.clarificationTranscript({
				hostId,
				conversationId,
				runId: home.runId,
			})
		).messages;
	const assistants = async () =>
		(await messages()).filter((message) => message.role === "assistant");
	const settle = async (after: number) => {
		for (let i = 0; i < 250; i++) {
			if (
				(await assistants()).length > after &&
				(await host.status(home.runId)).status === "idle"
			)
				return;
			await Bun.sleep(20);
		}
		throw new Error(
			`fake Home did not settle: ${JSON.stringify(await host.status(home.runId))}`,
		);
	};
	const turn = async (
		text: string,
		replies: Parameters<typeof faux.setResponses>[0],
		developer = false,
	) => {
		const before = (await assistants()).length;
		faux.setResponses(replies);
		if (developer)
			await submitOrchestratorDeveloperInput(
				client,
				session,
				text,
				crypto.randomUUID(),
				"followUp",
				server.token,
			);
		else
			await client.submit(
				home.runId,
				text,
				crypto.randomUUID(),
				"followUp",
				"internal",
			);
		await settle(before);
	};
	const toolTurn = async (
		actionId: string,
		input: Parameters<typeof fauxToolCall>[1],
		workflowId = run.workflowId,
	) => {
		await turn("Continue the pending clarification protocol.", [
			fauxAssistantMessage(
				[
					fauxToolCall("workflow_action", {
						repo,
						workflowId,
						revision: engine.status(repo, workflowId).revision,
						actionId,
						input,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([
				fauxText(
					"The protocol operation completed; no further authority is implied.",
				),
			]),
		]);
		const last = (await host.entriesForTest(home.runId))
			.filter((entry) => (entry as { kind?: string }).kind === "pi.tool-result")
			.at(-1);
		if (!last || JSON.stringify(last).includes('"isError":true'))
			throw new Error(`Native tool operation failed: ${JSON.stringify(last)}`);
	};
	const addWorkflow = async (workflowId: string) => {
		const second = engine.start({
			repo,
			workflowId,
			definitionId: "no-openspec",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "Use the agreed A implementation",
			},
			routing: {
				defaultProfile: "fake",
				routes: [{ stepId: "core.implementation", role: "worker", profile }],
			},
		});
		const secondRun = engine.getRun(repo, second.view.runs[0]?.id ?? "");
		const effect = engine
			.claimEffects(repo)
			.find((item) => item.kind === "agent.launch");
		if (!effect?.lease || !effect.runToken)
			throw new Error("second fixture launch missing");
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: effect.id,
			lease: effect.lease,
			outcome: "complete",
			data: { runtime: "pi-durable", name: "worker", paneId: "second-fake" },
		});
		const attached = await post(
			"clarification.attach",
			{ hostId, conversationId, homeRunId: home.runId },
			true,
			workflowId,
		);
		if (!attached.ok) throw new Error(await attached.text());
		return { run: secondRun, token: effect.runToken };
	};
	return {
		addWorkflow,
		root,
		repo,
		run,
		token,
		server,
		operations,
		setActionAdapter: (adapter: ServerOperations["action"]) => {
			actionAdapter = adapter;
		},
		client,
		home,
		hostId,
		conversationId,
		scopedToken,
		faux,
		view,
		post,
		messages,
		assistants,
		settle,
		turn,
		toolTurn,
		host: () => host,
		engine: () => engine,
		ask: (group = false) =>
			engine.dispatch(repo, {
				type: "agent.question",
				workflowId: run.workflowId,
				runId: run.id,
				stepId: run.stepId,
				role: run.role,
				token,
				...(group
					? {
							questions: [
								{
									question: "First?",
									options: [{ label: "Use A", value: "a" }],
								},
								{ question: "Second?", options: [] },
							],
						}
					: {
							description: "Which approach?",
							options: [{ label: "Use A", value: "a" }],
						}),
			}),
		block: () =>
			engine.dispatch(repo, {
				type: "agent.handoff",
				runId: run.id,
				generation: run.generation,
				token,
				outcome: "blocked",
				message: "Waiting for clarification",
			}),
		reopenEngine: () => {
			engine = new WorkflowEngine(registerBuiltins());
		},
		reopenHost: async () => {
			await host.shutdown();
			host = await DurableHost.open(hostOptions);
			await host.ensureRun({ ...home, expectedConversationId: conversationId });
			await host.listen();
		},
		cleanup: async () => {
			await host.shutdown();
			await server.stop();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
