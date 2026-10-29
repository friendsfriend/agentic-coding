import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
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
import { Effect } from "effect";
import {
	authenticatedHostClient,
	ensureHostRunning,
	HostLaunchVerificationError,
} from "../src/agent-host/client.ts";
import {
	clearEnvironmentServer,
	publishEnvironmentServer,
} from "../src/agent-host/environment-capability.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import type { DashboardGateway } from "../src/contracts/gateway.ts";
import type { LaunchClaim } from "../src/contracts/launch.ts";
import type {
	WorkflowEffect,
	WorkflowRecoveryPreview,
} from "../src/contracts/workflow.ts";
import { createServerApp } from "../src/server/app.ts";
import {
	createInstanceAuthority,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { clearGateway, configureGateway } from "../src/tui/data/index.ts";
import { loadDashboardSeed } from "../src/tui/data/workflow.ts";
import { PiDurableAdapter } from "../src/workflow/adapters.ts";
import { WorkflowApplication } from "../src/workflow/application.ts";
import { effectiveManifestPolicy } from "../src/workflow/definitions/manifest-policy.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import { agentEffectHandlers } from "../src/workflow/effect-runner.ts";
import { writeAgentRunEnv } from "../src/workflow/run-env.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(parallel = false) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "managed-launch-")),
	);
	const previous = {
		wiki: process.env.HERDR_WIKI_DIR,
		config: process.env.AGENTIC_CODING_CONFIG_DIR,
	};
	process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
	process.env.AGENTIC_CODING_CONFIG_DIR = path.join(root, "config");
	fs.mkdirSync(process.env.AGENTIC_CODING_CONFIG_DIR, { recursive: true });
	let time = Date.now();
	const clock = () => new Date(time);
	const application = new WorkflowApplication(clock);
	let stop = async () => {};
	cleanups.push(async () => {
		try {
			await stop();
		} finally {
			application.dispose();
			process.env.HERDR_WIKI_DIR = previous.wiki;
			process.env.AGENTIC_CODING_CONFIG_DIR = previous.config;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	const registry = registerBuiltins(undefined, 6);
	const roles = parallel
		? ["researcher", "fixture-verifier-a", "fixture-verifier-b"]
		: ["researcher"];
	let definitionId = "research";
	let definitionVersion = definitionVersionForPolicy(6);
	if (parallel) {
		const base = registry.definition("research", definitionVersion);
		const step = registry.stepForDefinition(base, "core.research");
		if (!step.behavior) throw new Error("fixture research behavior missing");
		registry.registerStep({
			...step,
			version: 99,
			behaviorVersion: 99,
			behavior: {
				...step.behavior,
				roles: () => roles,
				candidateRoles: () => roles,
				// Fixture fan-in retains each terminal result until the whole roster
				// settles, just as a parallel verifier step does.
				onAgentComplete: () => ({ deferTransition: true }),
			},
		});
		registry.registerWorkflow({
			...base,
			id: "research",
			version: 9901,
			policy: effectiveManifestPolicy(base),
			stepRefs: base.steps.map((id) => {
				const step = registry.stepForDefinition(base, id);
				return {
					id,
					version: id === "core.research" ? 99 : step.version,
					behaviorVersion:
						id === "core.research" ? 99 : (step.behaviorVersion ?? 1),
				};
			}),
		});
		definitionId = "research";
		definitionVersion = 9901;
	}
	const engine = new WorkflowEngine(
		registry,
		clock,
		() => {},
		application.layerOf(),
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 12 }, () =>
			fauxAssistantMessage([fauxText("fixture answer")]),
		),
	);
	const profile = {
		name: "fixture",
		runtime: "pi-durable" as const,
		executable: "pi-durable",
		tools: ["read"],
		extensions: [],
		readOnly: true,
		capabilities: [
			"prompt",
			"run-environment",
			"observe",
			"read-only",
		] as const,
		digest: "fixture",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	};
	const repo = researchWorkflowTarget();
	const workflowId = "managed-launch";
	engine.start({
		repo,
		workflowId,
		definitionId,
		definitionVersion,
		metadata: {
			branch: "",
			baseBranch: "",
			baseCommit: "",
			task: "fixture",
			startedBy: "orchestrator",
		},
		routing: {
			defaultProfile: profile.name,
			routes: roles.map((role) => ({ stepId: "core.research", role, profile })),
		},
	});
	function complete(effect: WorkflowEffect) {
		if (!effect.lease) throw new Error("fixture claim missing");
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: effect.id,
			lease: effect.lease,
			outcome: "complete",
		});
	}
	const readyLaunches: WorkflowEffect[] = [];
	function claimLaunch() {
		const ready = readyLaunches.shift();
		if (ready) return ready;
		for (let round = 0; round < 8; round++) {
			const effects = engine.claimEffects(repo);
			for (const effect of effects) {
				if (effect.kind === "agent.launch") readyLaunches.push(effect);
				else complete(effect);
			}
			const launch = readyLaunches.shift();
			if (launch) return launch;
		}
		throw new Error("fixture launch unavailable");
	}
	const first = claimLaunch();
	const claim = (effect: WorkflowEffect): LaunchClaim => ({
		repo,
		workflowId,
		runId: String((effect.payload as { runId: string }).runId),
		effectId: effect.id,
		lease: effect.lease ?? "",
	});
	const permit = engine.verifyLaunch(claim(first));
	fs.mkdirSync(path.dirname(permit.hostRoot), { recursive: true });
	const envFile = writeAgentRunEnv({
		cwd: permit.cwd,
		runDirectory: path.dirname(permit.hostRoot),
		runId: claim(first).runId,
		environment: {
			HERDR_WORKFLOW_ID: workflowId,
			HERDR_RUN_ID: claim(first).runId,
			HERDR_ROLE: "researcher",
		},
	});
	expect(envFile).toBe(permit.runEnvPath);
	fs.mkdirSync(permit.cwd, { recursive: true });
	const layout = hostLayout(path.dirname(permit.hostRoot));
	const open = () =>
		DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: root,
			models,
		});
	let host = await open();
	stop = async () => {
		await host.shutdown();
	};
	await host.listen();
	const authority = createInstanceAuthority(
		"managed-launch-test",
		"isolated-instance-capability",
	);
	const operations = {
		view: () => engine.status(repo, workflowId),
		verifyLaunch: (value: LaunchClaim) => engine.verifyLaunch(value),
		runObservation: async () => [{ workflowId, target: repo }],
		launchRecoveryPreview: (target: string, id: string, revision: number) =>
			application.runPromise(
				engine.launchRecoveryPreviewEffect(target, id, revision),
			),
		reconcileLaunch: async (
			request: {
				revision: number;
				targetStep: string;
				reason: string;
				recovery: unknown;
			},
			options?: { principal?: string },
		) =>
			(
				await application.runPromise(
					engine.reconcileLaunchEffect(repo, {
						type: "operator.repair",
						workflowId,
						revision: request.revision,
						targetStep: request.targetStep,
						reason: request.reason,
						recovery: request.recovery,
						principal: options?.principal ?? "operator",
					}),
				)
			).view,
	} as unknown as ServerOperations;
	const app = createServerApp({
		authority,
		operations,
		events: new EventBroker(authority.instance),
		credentials: new CredentialRegistry(),
		configDir: process.env.AGENTIC_CODING_CONFIG_DIR,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	const url = `http://127.0.0.1:${server.port}`;
	publishEnvironmentServer({ url, token: authority.token });
	const post = (route: string, body: unknown, token = authority.token) =>
		app.fetch(
			new Request(`http://localhost/api/v1/workflow/${route}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	const admission = (effect = first) => ({
		type: "admitWorkflowRun" as const,
		runId: claim(effect).runId,
		claim: claim(effect),
		name: "untrusted-client-name",
		cwd: "/untrusted-client-path",
		runEnvPath: "/untrusted-client-env",
		toolPolicy: "default" as const,
		text: "isolated initial assignment",
		requestId: `${effect.id}:initial`,
	});
	stop = async () => {
		clearEnvironmentServer(authority.token);
		try {
			await host.shutdown();
		} finally {
			await server.stop(true);
		}
	};
	return {
		engine,
		registry,
		faux,
		profile,
		repo,
		workflowId,
		first,
		claim,
		admission,
		post,
		authority,
		url,
		permit,
		layout,
		application,
		complete,
		claimLaunch,
		host: () => host,
		expire: () => {
			time += 120_000;
		},
		restart: async () => {
			await host.shutdown();
			host = await open();
			await host.listen();
			return host;
		},
		writeEnv: (effect: WorkflowEffect) =>
			writeAgentRunEnv({
				cwd: permit.cwd,
				runDirectory: path.dirname(permit.hostRoot),
				runId: claim(effect).runId,
				environment: {
					HERDR_WORKFLOW_ID: workflowId,
					HERDR_RUN_ID: claim(effect).runId,
					HERDR_ROLE: engine.getRun(repo, claim(effect).runId).role,
				},
			}),
	};
}
async function idle(host: DurableHost, runId: string) {
	for (let i = 0; i < 200; i++) {
		if ((await host.status(runId)).status === "idle") return;
		await Bun.sleep(5);
	}
	throw new Error("faux task did not settle");
}
async function preview(f: Awaited<ReturnType<typeof fixture>>) {
	const response = await f.post("recovery-preview", {
		repo: f.repo,
		workflowId: f.workflowId,
		revision: f.engine.getSnapshot(f.repo, f.workflowId).revision,
	});
	if (response.status !== 200)
		throw new Error(
			`Preview failed: ${response.status} ${await response.text()}`,
		);
	return ((await response.json()) as { value: WorkflowRecoveryPreview }).value;
}
function recoveryRequest(
	f: Awaited<ReturnType<typeof fixture>>,
	value: WorkflowRecoveryPreview,
) {
	return {
		repo: f.repo,
		workflowId: f.workflowId,
		revision: value.revision,
		targetStep: value.targetStep,
		reason: "Reconcile the expired launch",
		recovery: {
			previewId: value.previewId,
			operation: value.operation,
			instruction: "Continue the existing agreed task after launch cleanup.",
		},
	};
}

test("managed admission requires authenticated server authority; arbitrary fields and old protocol cannot authorize a launch", async () => {
	const f = await fixture();
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	const view = f.engine.status(f.repo, f.workflowId);
	expect(view.runs[0]?.launchState).toBe("launching");
	configureGateway({ view: async () => view } as unknown as DashboardGateway);
	try {
		expect(
			(await loadDashboardSeed(f.repo, f.workflowId))?.agents[0]
				?.admissionState,
		).toBe("launching");
	} finally {
		clearGateway();
	}
	const rejected = await f.post(
		"verify-launch",
		f.claim(f.first),
		orchestratorTokenFor(f.authority.token),
	);
	expect(rejected.status).toBe(403);
	clearEnvironmentServer(f.authority.token);
	try {
		await authenticatedHostClient(f.layout.socketPath).admitWorkflowRun(
			f.admission(),
		);
		throw new Error("unexpected admission");
	} catch (error) {
		expect(error).toBeInstanceOf(HostLaunchVerificationError);
		expect((error as HostLaunchVerificationError).retryable).toBe(true);
	}
	expect(await f.host().inspectLaunch(f.claim(f.first).runId)).toMatchObject({
		state: "absent",
		activity: "absent",
	});
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
	await expect(
		f.host().ensureRun({
			...f.admission(),
			runEnvPath: f.permit.runEnvPath,
			cwd: f.permit.cwd,
		}),
	).rejects.toThrow("server-verified");
	publishEnvironmentServer({ url: f.url, token: f.authority.token });
	const submit = spyOn(f.host(), "submit");
	const first = await authenticatedHostClient(
		f.layout.socketPath,
	).admitWorkflowRun(f.admission());
	const second = await f.host().admitWorkflowRun(f.admission());
	expect(first.conversationId).toBe(second.conversationId);
	expect(submit).toHaveBeenCalledTimes(1);
	submit.mockRestore();
	await idle(f.host(), f.claim(f.first).runId);
	const reopened = await f.restart();
	const replay = spyOn(reopened, "submit");
	expect((await reopened.admitWorkflowRun(f.admission())).conversationId).toBe(
		first.conversationId,
	);
	expect(replay).not.toHaveBeenCalled();
	replay.mockRestore();
});

test("crash after submit replays the original native request identity across host restart", async () => {
	const f = await fixture();
	const host = f.host();
	const original = host.submit.bind(host);
	let firstId: string | undefined;
	const crash = spyOn(host, "submit").mockImplementation(async (...args) => {
		const result = await original(...args);
		firstId = result.submissionId;
		throw new Error("fixture crash after durable submit");
	});
	await expect(host.admitWorkflowRun(f.admission())).rejects.toThrow(
		"fixture crash",
	);
	crash.mockRestore();
	await idle(host, f.claim(f.first).runId);
	expect(await host.inspectLaunch(f.claim(f.first).runId)).toMatchObject({
		state: "prepared",
		activity: "idle",
	});
	const reopened = await f.restart();
	const resubmit = spyOn(reopened, "submit");
	await reopened.admitWorkflowRun(f.admission());
	expect(resubmit).toHaveBeenCalledTimes(1);
	const submitted = resubmit.mock.results[0]?.value as
		| Awaited<ReturnType<DurableHost["submit"]>>
		| Promise<Awaited<ReturnType<DurableHost["submit"]>>>
		| undefined;
	expect((await submitted)?.submissionId).toBe(firstId);
	resubmit.mockRestore();
});

test("expired absent launch recovery re-drives the same run in place and fences delayed admissions", async () => {
	const f = await fixture();
	const current = await preview(f);
	expect(current.eligible).toBe(false);
	expect(current.launches?.[0]?.claimState).toBe("live");
	f.expire();
	const value = await preview(f);
	expect(value.operation).toBe("reconcile-launch");
	expect(value.eligible).toBe(true);
	expect(value.launches?.[0]).toMatchObject({
		claimState: "expired",
		admission: { state: "absent", activity: "absent" },
	});
	expect(JSON.stringify(value)).not.toContain(f.first.lease ?? "missing-lease");
	const request = recoveryRequest(f, value);
	const responses = await Promise.all([
		f.post("repair", request),
		f.post("repair", request),
	]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 409,
	]);
	const snapshot = f.engine.getSnapshot(f.repo, f.workflowId);
	expect(snapshot.step.attempt).toBe(1);
	expect(f.engine.status(f.repo, f.workflowId).runs[0]?.launchState).toBe(
		"queued",
	);
	expect(snapshot.repaired?.recovery?.operation).toBe("reconcile-launch");
	await expect(f.host().admitWorkflowRun(f.admission())).rejects.toThrow(
		"Launch claim refused",
	);
	const db = new Database(canonicalStorePath(f.repo));
	try {
		expect(
			db.query("SELECT status FROM workflow_outbox WHERE id=?").get(f.first.id),
		).toEqual({ status: "pending" });
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM workflow_events WHERE type='operator.repair'",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
	} finally {
		db.close();
	}
	// Re-drive through ordinary dispatch with a fresh claim, not a new run,
	// generation, effect identity or recovery-specific launch queue.
	const replacement = f.claimLaunch();
	expect(replacement.id).toBe(f.first.id);
	expect(f.claim(replacement).runId).toBe(f.claim(f.first).runId);
	expect(replacement.lease).not.toBe(f.first.lease);
	f.writeEnv(replacement);
	await f.host().admitWorkflowRun(f.admission(replacement));
	expect(await f.host().inspectLaunch(f.claim(f.first).runId)).toMatchObject({
		state: "admitted",
	});
	await expect(f.host().admitWorkflowRun(f.admission())).rejects.toThrow();
	const beforeLate = f.engine.getSnapshot(f.repo, f.workflowId);
	expect(() => f.complete(f.first)).toThrow();
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(beforeLate);
});

test("a renewed lease invalidates inspected recovery even without a workflow revision change", async () => {
	const f = await fixture();
	f.expire();
	const value = await preview(f);
	expect(value.eligible).toBe(true);
	const db = new Database(canonicalStorePath(f.repo));
	try {
		db.query("UPDATE workflow_outbox SET lease_expires_at=? WHERE id=?").run(
			new Date(Date.now() + 3600_000).toISOString(),
			f.first.id,
		);
	} finally {
		db.close();
	}
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	const response = await f.post("repair", recoveryRequest(f, value));
	expect(response.status).toBe(409);
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
});

test("a malformed claim expiry is unknown ownership, not permission to reconcile or admit", async () => {
	const f = await fixture();
	const db = new Database(canonicalStorePath(f.repo));
	try {
		db.query(
			"UPDATE workflow_outbox SET lease_expires_at='zz-invalid' WHERE id=?",
		).run(f.first.id);
	} finally {
		db.close();
	}
	const value = await preview(f);
	expect(value.eligible).toBe(false);
	expect(value.launches?.[0]?.claimState).toBe("malformed");
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	expect((await f.post("repair", recoveryRequest(f, value))).status).toBe(409);
	await expect(f.host().admitWorkflowRun(f.admission())).rejects.toThrow(
		"Launch claim refused",
	);
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
});

test("crashes before ensure and before native submit re-drive one durable initial request", async () => {
	for (const boundary of ["ensureRun", "submit"] as const) {
		const f = await fixture();
		const crash = spyOn(f.host(), boundary).mockRejectedValueOnce(
			new Error(`fixture crash before ${boundary}`),
		);
		try {
			await expect(f.host().admitWorkflowRun(f.admission())).rejects.toThrow(
				`fixture crash before ${boundary}`,
			);
		} finally {
			crash.mockRestore();
		}
		expect(await f.host().inspectLaunch(f.claim(f.first).runId)).toMatchObject({
			state: "prepared",
		});
		const reopened = await f.restart();
		const submit = spyOn(reopened, "submit");
		try {
			await reopened.admitWorkflowRun(f.admission());
			expect(submit).toHaveBeenCalledTimes(1);
			await reopened.admitWorkflowRun(f.admission());
			expect(submit).toHaveBeenCalledTimes(1);
		} finally {
			submit.mockRestore();
		}
	}
});

test("renewal during authenticated observation invalidates recovery at the commit boundary", async () => {
	const f = await fixture();
	f.expire();
	const value = await preview(f);
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	const original = f.host().inspectLaunch.bind(f.host());
	const observe = spyOn(f.host(), "inspectLaunch").mockImplementationOnce(
		async (runId) => {
			const observed = await original(runId);
			const db = new Database(canonicalStorePath(f.repo));
			try {
				db.query(
					"UPDATE workflow_outbox SET lease_expires_at=? WHERE id=?",
				).run(new Date(Date.now() + 600_000).toISOString(), f.first.id);
			} finally {
				db.close();
			}
			return observed;
		},
	);
	try {
		expect((await f.post("repair", recoveryRequest(f, value))).status).toBe(
			409,
		);
		expect(observe).toHaveBeenCalledTimes(1);
	} finally {
		observe.mockRestore();
	}
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
	const db = new Database(canonicalStorePath(f.repo));
	try {
		expect(
			db
				.query("SELECT status,lease FROM workflow_outbox WHERE id=?")
				.get(f.first.id),
		).toEqual({ status: "running", lease: f.first.lease });
	} finally {
		db.close();
	}
});

test("persisted managed handles cannot bypass verified admission or submit another initial turn", async () => {
	const f = await fixture();
	const admitted = await f.host().admitWorkflowRun(f.admission());
	await idle(f.host(), f.claim(f.first).runId);
	const handle = {
		runtime: "pi-durable",
		hostSocket: f.layout.socketPath,
		sessionId: f.claim(f.first).runId,
		conversationId: admitted.conversationId,
		name: f.permit.name,
	};
	const db = new Database(canonicalStorePath(f.repo));
	try {
		db.query("UPDATE workflow_runs SET handle_json=? WHERE id=?").run(
			JSON.stringify(handle),
			handle.sessionId,
		);
	} finally {
		db.close();
	}
	const adapter = new PiDurableAdapter();
	const observe = spyOn(adapter, "observe");
	const prompt = spyOn(adapter, "prompt");
	try {
		const handlers = agentEffectHandlers(f.repo, f.engine, {
			registry: f.registry,
			adapters: new Map([["pi-durable", adapter]]),
		});
		const reuse = handlers["agent.launch"]?.observe;
		if (!reuse) throw new Error("fixture launch observation missing");
		expect(
			await Effect.runPromise(reuse(f.first, new AbortController().signal)),
		).toBeUndefined();
		expect(observe).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	} finally {
		observe.mockRestore();
		prompt.mockRestore();
	}
});

test("a launch inspection expires even when its source records do not change", async () => {
	const f = await fixture();
	f.expire();
	const value = await preview(f);
	expect(value.eligible).toBe(true);
	expect(value.observationExpiresAt).toBeDefined();
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	f.expire();
	expect((await f.post("repair", recoveryRequest(f, value))).status).toBe(409);
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
});

test("unavailable host observation stays unknown and recovery does not start a host or mutate intent", async () => {
	const f = await fixture();
	f.expire();
	const value = await preview(f);
	await f.host().shutdown();
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	const unavailable = await f.post("recovery-preview", {
		repo: f.repo,
		workflowId: f.workflowId,
		revision: before.revision,
	});
	expect(unavailable.status).toBe(409);
	expect(await unavailable.json()).toMatchObject({
		error: { code: "unavailable" },
	});
	expect(fs.existsSync(f.layout.socketPath)).toBe(false);
	expect((await f.post("repair", recoveryRequest(f, value))).status).toBe(409);
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
	expect(fs.existsSync(f.layout.socketPath)).toBe(false);
});

test("an accepted stop crash is settled durably before native host restart resumes work", async () => {
	const f = await fixture();
	await f.host().admitWorkflowRun(f.admission());
	await idle(f.host(), f.claim(f.first).runId);
	const db = new Database(canonicalStorePath(f.repo));
	try {
		db.query(
			"UPDATE workflow_outbox SET payload_json=json_set(payload_json,'$.cancelRequested',1) WHERE id=?",
		).run(f.first.id);
	} finally {
		db.close();
	}
	const target = f.host() as unknown as {
		finishStopBarrier: (id: string) => Promise<void>;
	};
	const crash = spyOn(target, "finishStopBarrier").mockRejectedValue(
		new Error("fixture crash after accepted stop"),
	);
	try {
		await expect(
			f.host().fenceStoppedRun({ ...f.claim(f.first), intent: "stop" }),
		).rejects.toThrow("fixture crash");
	} finally {
		crash.mockRestore();
	}
	expect(await f.host().inspectLaunch(f.claim(f.first).runId)).toMatchObject({
		state: "stopping",
		activity: "unknown",
	});
	const reopened = await f.restart();
	expect(await reopened.inspectLaunch(f.claim(f.first).runId)).toMatchObject({
		state: "stopped",
	});
	await expect(reopened.admitWorkflowRun(f.admission())).rejects.toThrow(
		"Launch claim refused",
	);
});

test("admitted work reconciles in place without submitting a second initial turn", async () => {
	const f = await fixture();
	const admitted = await f.host().admitWorkflowRun(f.admission());
	await idle(f.host(), f.claim(f.first).runId);
	f.expire();
	const value = await preview(f);
	expect(value.eligible).toBe(true);
	expect(value.launches?.[0]?.admission?.state).toBe("admitted");
	const response = await f.post("repair", recoveryRequest(f, value));
	expect(response.status).toBe(200);
	const claim = f.claimLaunch();
	expect(claim.id).toBe(f.first.id);
	const submit = spyOn(f.host(), "submit");
	try {
		expect(await f.host().admitWorkflowRun(f.admission(claim))).toEqual(
			admitted,
		);
		expect(submit).not.toHaveBeenCalled();
	} finally {
		submit.mockRestore();
	}
	expect(f.engine.getSnapshot(f.repo, f.workflowId).step.attempt).toBe(1);
});

test("historical obsolete launch plus current pending lease refuses live ownership then reconciles exactly those records", async () => {
	const f = await fixture();
	const oldRun = "fixture-obsolete-run";
	const oldEffect = "fixture-obsolete-effect";
	const db = new Database(canonicalStorePath(f.repo));
	try {
		const row = db
			.query("SELECT snapshot_json FROM workflow_instances WHERE id=?")
			.get(f.workflowId) as { snapshot_json: string };
		const stored = JSON.parse(row.snapshot_json);
		stored.step.attempt = 2;
		db.query("UPDATE workflow_instances SET snapshot_json=? WHERE id=?").run(
			JSON.stringify(stored),
			f.workflowId,
		);
		db.query(
			"INSERT INTO workflow_runs(id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,created_at) SELECT ?,workflow_id,step_id,role,1,1,'failed',profile_json,issued_revision,allowed_outcomes_json,'',capability_expires_at,assignment_path,created_at FROM workflow_runs WHERE id=?",
		).run(oldRun, f.claim(f.first).runId);
		db.query("UPDATE workflow_runs SET generation=2,attempt=2 WHERE id=?").run(
			f.claim(f.first).runId,
		);
		db.query(
			"INSERT INTO workflow_outbox(id,workflow_id,revision,kind,idempotency_key,payload_json,status,attempts,max_attempts,last_error) VALUES(?,?,?,'agent.launch',?,?,'failed',1,3,'original isolated admission failure')",
		).run(
			oldEffect,
			f.workflowId,
			0,
			oldEffect,
			JSON.stringify({
				...(f.first.payload as Record<string, unknown>),
				runId: oldRun,
			}),
		);
	} finally {
		db.close();
	}
	const live = await preview(f);
	expect(live.operation).toBe("reconcile-launch");
	expect(live.eligible).toBe(false);
	expect(
		live.launches?.find((launch) => launch.effectId === f.first.id)?.claimState,
	).toBe("live");
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	expect((await f.post("repair", recoveryRequest(f, live))).status).toBe(409);
	expect(f.engine.getSnapshot(f.repo, f.workflowId)).toEqual(before);
	f.expire();
	const value = await preview(f);
	expect(value.eligible).toBe(true);
	expect(value.affectedRuns).toContain(oldRun);
	expect((await f.post("repair", recoveryRequest(f, value))).status).toBe(200);
	const snapshot = f.engine.getSnapshot(f.repo, f.workflowId);
	expect(snapshot.step.attempt).toBe(2);
	expect(snapshot.step.activeRunIds).toEqual(before.step.activeRunIds);
	expect(snapshot.repaired?.retiredRuns).toEqual([oldRun]);
	const check = new Database(canonicalStorePath(f.repo));
	try {
		expect(
			check
				.query("SELECT status,last_error FROM workflow_outbox WHERE id=?")
				.get(oldEffect),
		).toEqual({
			status: "expired",
			last_error: "original isolated admission failure",
		});
	} finally {
		check.close();
	}
	for (const effect of f.engine.claimEffects(f.repo)) {
		expect(effect.kind).toBe("agent.stop");
		await f.host().fenceStoppedRun({ ...f.claim(effect), intent: "stop" });
		f.complete(effect);
	}
	const current = f.claimLaunch();
	expect(current.id).toBe(f.first.id);
	f.writeEnv(current);
	await f.host().admitWorkflowRun(f.admission(current));
	// Continue through real native turns, authorized terminal handoffs, scoped
	// stop barriers and normal same-step repair, not another reconcile loop.
	let launches = [current];
	for (let cycle = 0; cycle < 2; cycle++) {
		launches = await finishCycleAndRepair(f, launches);
		for (const launch of launches) {
			f.writeEnv(launch);
			await f.host().admitWorkflowRun(f.admission(launch));
			await idle(f.host(), f.claim(launch).runId);
		}
	}
	expect(f.engine.getRun(f.repo, oldRun).status).toBe("failed");
	expect(f.engine.getSnapshot(f.repo, f.workflowId).step.attempt).toBe(4);
});

async function finishCycleAndRepair(
	f: Awaited<ReturnType<typeof fixture>>,
	launches: WorkflowEffect[],
) {
	const ids = launches.map((launch) => f.claim(launch).runId);
	for (const launch of launches) {
		const run = f.engine.getRun(f.repo, f.claim(launch).runId);
		await idle(f.host(), run.id);
		f.complete(launch);
		const token = f.engine.issueRunCapability(f.repo, run.id);
		f.engine.dispatch(f.repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "failed",
			message: "fixture terminal outcome retained across subsequent cycles",
		});
	}
	const before = f.engine.getSnapshot(f.repo, f.workflowId);
	// Built-in research failure already enters its next attempt. The fixture
	// verifier fan-in instead waits for an explicit same-step operator repair.
	if (before.step.activeRunIds.length === 0) {
		const repaired = f.engine.dispatch(f.repo, {
			type: "operator.repair",
			workflowId: f.workflowId,
			revision: before.revision,
			targetStep: before.currentStep,
			reason: "fixture normal next lifecycle cycle",
		});
		expect(repaired.snapshot.evidence).toEqual(before.evidence);
		expect(repaired.snapshot.metadata).toEqual(before.metadata);
	}
	const next: WorkflowEffect[] = [];
	for (let round = 0; round < 8 && next.length < launches.length; round++) {
		for (const effect of f.engine.claimEffects(f.repo)) {
			if (effect.kind === "agent.launch") next.push(effect);
			else {
				if (effect.kind === "agent.stop")
					await f
						.host()
						.fenceStoppedRun({ ...f.claim(effect), intent: "stop" });
				f.complete(effect);
			}
		}
	}
	expect(next).toHaveLength(launches.length);
	for (const id of ids) {
		expect(f.engine.getRun(f.repo, id).status).toBe("failed");
		// Terminal handoff leaves an idle reusable session, or explicit repair
		// settles its stop obligation. Neither can describe active native work.
		const observed = await f.host().inspectLaunch(id);
		expect([
			{ state: "admitted", activity: "idle" },
			{ state: "stopped", activity: "absent" },
		]).toContainEqual({ state: observed.state, activity: observed.activity });
	}
	return next;
}

test("fresh managed launcher processes admit simultaneous verifier roles for repeated cycles while unrelated work and privileged recovery remain isolated", async () => {
	const f = await fixture(true);
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 10" })], {
			stopReason: "toolUse",
		}),
		...Array.from({ length: 24 }, () =>
			fauxAssistantMessage([fauxText("fixture answer")]),
		),
	]);
	await f.host().ensureRun({
		runId: "fixture-busy",
		name: "fixture-busy",
		cwd: f.permit.cwd,
		runEnvPath: "",
		toolPolicy: "default",
		model: f.profile.model,
	});
	await f.host().submit("fixture-busy", "fixture work", "fixture-busy-request");
	for (
		let i = 0;
		i < 100 && (await f.host().status("fixture-busy")).status !== "working";
		i++
	)
		await Bun.sleep(5);
	expect((await f.host().status("fixture-busy")).status).toBe("working");
	const inode = fs.statSync(f.layout.socketPath).ino;
	let launches = [f.first, f.claimLaunch(), f.claimLaunch()];
	const adapterPath = path.resolve(
		import.meta.dir,
		"../src/workflow/adapters.ts",
	);
	const conversations = new Map<string, string>();
	for (let cycle = 0; cycle < 3; cycle++) {
		const contexts = launches.map((launch) => {
			const run = f.engine.getRun(f.repo, f.claim(launch).runId);
			return {
				profile: f.profile,
				assignment: { runId: run.id, workflowId: f.workflowId },
				claim: f.claim(launch),
				rendered: {
					prompt: "fixture verification",
					digest: "fixture",
					bytes: 20,
				},
				cwd: f.permit.cwd,
				runDirectory: path.dirname(f.permit.hostRoot),
				name: run.role,
				environment: {
					HERDR_WORKFLOW_ID: f.workflowId,
					HERDR_RUN_ID: run.id,
					HERDR_ROLE: run.role,
				},
			};
		});
		const script = `import {Effect} from 'effect';import {PiDurableAdapter} from ${JSON.stringify(adapterPath)};const adapter=new PiDurableAdapter();const contexts=${JSON.stringify(contexts)};const handles=await Promise.all(contexts.map(ctx=>Effect.runPromise(adapter.launch(ctx))));const replay=await Promise.all(contexts.map(ctx=>Effect.runPromise(adapter.launch(ctx))));if(handles.some((h,i)=>h.retryTargetLease || h.conversationId!==replay[i].conversationId))throw new Error('ordinary admission leaked authority or duplicated ownership');console.log(JSON.stringify(handles.map(h=>({runId:h.sessionId,conversationId:h.conversationId}))));`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const recovery = ensureHostRunning(
			f.layout,
			{ command: process.execPath, args: [], cwd: f.permit.cwd },
			{ requireRetryAuthority: true },
		);
		await expect(recovery).rejects.toThrow("active");
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, error }).toEqual({ code: 0, error: "" });
		const handles = JSON.parse(output) as Array<{
			runId: string;
			conversationId: string;
		}>;
		expect(handles).toHaveLength(3);
		expect(new Set(handles.map((h) => h.conversationId)).size).toBe(3);
		for (const handle of handles) {
			const role = f.engine.getRun(f.repo, handle.runId).role;
			const prior = conversations.get(role);
			if (prior) expect(handle.conversationId).toBe(prior);
			conversations.set(role, handle.conversationId);
			await idle(f.host(), handle.runId);
			expect(await f.host().inspectLaunch(handle.runId)).toMatchObject({
				state: "admitted",
				activity: "idle",
			});
		}
		// Rebound historical associations must not report the successor's activity.
		for (const run of f.engine
			.status(f.repo, f.workflowId)
			.runs.filter((run) => run.status === "failed")) {
			const observed = await f.host().inspectLaunch(run.id);
			expect([
				{ state: "admitted", activity: "unknown" },
				{ state: "stopped", activity: "absent" },
			]).toContainEqual({ state: observed.state, activity: observed.activity });
		}
		expect(fs.statSync(f.layout.socketPath).ino).toBe(inode);
		expect((await f.host().status("fixture-busy")).status).toBe("working");
		if (cycle < 2) launches = await finishCycleAndRepair(f, launches);
	}
}, 30000);
