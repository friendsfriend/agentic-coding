import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	recoverDurableHandle,
	recoverWorkflowSession,
	recoveryRequest,
} from "../src/agent-host/recovery.ts";
import {
	hostRetryCapabilityForLaunch,
	hostRetryTargetFor,
	releaseHostRetryCapability,
} from "../src/agent-host/retry-authority.ts";
import {
	type AgentHandle,
	DEVELOPER_ABORT_MESSAGE,
	type ResolvedProfile,
} from "../src/contracts/workflow.ts";
import { PiDurableAdapter } from "../src/workflow/adapters.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { writeAgentRunEnv } from "../src/workflow/run-env.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();
const retryAuthorities: Array<{ socket: string; capability: string }> = [];
afterEach(() => {
	for (const { socket, capability } of retryAuthorities.splice(0))
		releaseHostRetryCapability(socket, capability);
});

function fixture() {
	const repo = fs.realpathSync(
		createTempRepoFixture("session-recovery-", repoPreset.readme),
	);
	const profile: ResolvedProfile = {
		name: "fake",
		runtime: "pi-durable",
		executable: process.execPath,
		tools: [],
		extensions: [],
		readOnly: true,
		capabilities: ["prompt", "read-only", "run-environment", "observe"],
		digest: "fake",
	};
	const engine = new WorkflowEngine(registerBuiltins());
	const started = engine.start({
		repo,
		workflowId: "change",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "task",
		},
		routing: {
			defaultProfile: "fake",
			routes: ["core.plan", "core.implementation", "core.triage"].map(
				(stepId) => ({ stepId, profile }),
			),
		},
	});
	const view = started.view.runs[0];
	const token = engine
		.claimEffects(repo, 100)
		.find((effect) => effect.kind === "agent.launch")?.runToken;
	if (!view || !token) throw new Error("missing launch");
	const run = engine.getRun(repo, view.id);
	const layout = hostLayout(path.join(repo, ".herdr-workflow"));
	const runEnvPath = writeAgentRunEnv({
		cwd: repo,
		runId: run.id,
		environment: {
			HERDR_WORKFLOW_TARGET: repo,
			HERDR_WORKFLOW_ID: "change",
			HERDR_RUN_ID: run.id,
			HERDR_STEP_ID: run.stepId,
			HERDR_ROLE: run.role,
			HERDR_RUN_TOKEN: token,
		},
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const retryCapability = hostRetryCapabilityForLaunch(layout.socketPath);
	retryAuthorities.push({
		socket: layout.socketPath,
		capability: retryCapability,
	});
	const open = () =>
		DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: repo,
			models,
			retryCapability,
		});
	const persist = (conversationId: string) => {
		const handle: AgentHandle = {
			runtime: "pi-durable",
			name: "worker-test",
			sessionId: run.id,
			hostSocket: layout.socketPath,
			conversationId,
		};
		const db = new Database(canonicalStorePath(repo));
		try {
			db.query("UPDATE workflow_runs SET handle_json=? WHERE id=?").run(
				JSON.stringify(handle),
				run.id,
			);
		} finally {
			db.close();
		}
		return handle;
	};
	return { repo, engine, run, token, layout, runEnvPath, open, persist };
}

test("a restarted SQLite host recovers the exact aborted worker without clearing its park", async () => {
	const f = fixture();
	const first = await f.open();
	const ensured = await first.ensureRun({
		runId: f.run.id,
		name: "worker-test",
		cwd: f.repo,
		runEnvPath: f.runEnvPath,
		toolPolicy: "read-only",
	});
	const handle = f.persist(ensured.conversationId);
	f.engine.dispatch(f.repo, {
		type: "agent.handoff",
		runId: f.run.id,
		generation: f.run.generation,
		token: f.token,
		outcome: "blocked",
		aborted: true,
		message: DEVELOPER_ABORT_MESSAGE,
	});
	const before = f.engine.getSnapshot(f.repo, "change");
	await first.shutdown();
	const second = await f.open();
	await second.listen();
	try {
		expect((await second.status(f.run.id)).status).toBe("unknown");
		expect(
			(await Effect.runPromise(new PiDurableAdapter().observe(handle))).status,
		).toBe("idle");
		const recovered = await recoverWorkflowSession(f.repo, "change", f.run.id);
		expect(recovered.conversationId).toBe(ensured.conversationId);
		expect(
			hostRetryTargetFor(f.run.id, recovered.conversationId),
		).toBeDefined();
		expect((await second.status(f.run.id)).status).toBe("idle");
		expect(await recoverDurableHandle(handle)).toEqual(recovered);
		expect(f.engine.getRun(f.repo, f.run.id).status).toBe("blocked");
		expect(f.engine.getSnapshot(f.repo, "change").revision).toBe(
			before.revision,
		);
		expect(f.engine.getSnapshot(f.repo, "change").attention).toEqual([
			DEVELOPER_ABORT_MESSAGE,
		]);
		const request = recoveryRequest(before, f.engine.getRun(f.repo, f.run.id));
		expect(request?.toolPolicy).toBe("read-only");
		// The original retained capability still goes through the existing reducer.
		f.engine.dispatch(f.repo, {
			type: "agent.resume",
			workflowId: "change",
			runId: f.run.id,
			stepId: f.run.stepId,
			role: f.run.role,
			token: f.token,
		});
		expect(f.engine.getRun(f.repo, f.run.id).status).toBe("working");
	} finally {
		await second.shutdown();
	}
});

test("recovery rejects missing/rebound conversations without creating a replacement", async () => {
	const f = fixture();
	const host = await f.open();
	await host.listen();
	try {
		const client = new HostClient(f.layout.socketPath);
		const input = {
			runId: f.run.id,
			name: "worker-test",
			cwd: f.repo,
			runEnvPath: f.runEnvPath,
			toolPolicy: "read-only" as const,
			expectedConversationId: "999",
		};
		await expect(client.recoverRun(input)).rejects.toThrow(
			"ownership mismatch",
		);
		expect((await host.status(f.run.id)).status).toBe("unknown");
		const ensured = await host.ensureRun(inputWithoutExpected(input));
		await expect(
			client.recoverRun({
				...input,
				runId: "another-run",
				expectedConversationId: ensured.conversationId,
			}),
		).rejects.toThrow("another live owner");
		await expect(client.recoverRun(input)).rejects.toThrow(
			"ownership mismatch",
		);
		expect(
			(
				await client.recoverRun({
					...input,
					expectedConversationId: ensured.conversationId,
				})
			).conversationId,
		).toBe(ensured.conversationId);
	} finally {
		await host.shutdown();
	}
});

function inputWithoutExpected<T extends { expectedConversationId: string }>(
	input: T,
): Omit<T, "expectedConversationId"> {
	const { expectedConversationId: _, ...rest } = input;
	return rest;
}

test("foreign socket, launch identity, and historical attempts cannot recover a writable run", async () => {
	const f = fixture();
	f.persist("186");
	const run = f.engine.getRun(f.repo, f.run.id);
	const snapshot = f.engine.getSnapshot(f.repo, "change");
	expect(
		recoveryRequest(snapshot, { ...run, attempt: run.attempt + 1 }),
	).toBeUndefined();
	expect(
		recoveryRequest({ ...snapshot, status: "closed" }, run),
	).toBeUndefined();
	expect(() =>
		recoveryRequest(snapshot, {
			...run,
			handle: {
				...run.handle,
				runtime: "pi-durable",
				name: "worker-test",
				sessionId: run.id,
				conversationId: "186",
				hostSocket: "/tmp/foreign.sock",
			},
		}),
	).toThrow("socket ownership mismatch");
	fs.writeFileSync(f.runEnvPath, "HERDR_RUN_ID='different-run'\n", {
		mode: 0o600,
	});
	await expect(
		recoverWorkflowSession(f.repo, "change", run.id),
	).rejects.toThrow("launch environment");
	expect(fs.existsSync(f.layout.socketPath)).toBe(false);
});

test("opening a saved session starts an absent host and restores its SQLite binding", async () => {
	const f = fixture();
	const first = await f.open();
	const ensured = await first.ensureRun({
		runId: f.run.id,
		name: "worker-test",
		cwd: f.repo,
		runEnvPath: f.runEnvPath,
		toolPolicy: "read-only",
	});
	f.persist(ensured.conversationId);
	await first.shutdown();
	const driver = path.join(f.repo, "recovery-driver.ts");
	// Source-mode self-exec deliberately re-enters this driver with `agent host`.
	// Route that child to the real CLI, not a mock host or a pre-listening socket.
	fs.writeFileSync(
		driver,
		`
		if (process.argv[2] === "agent") {
			await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/cli.ts"))});
		} else {
			const { recoverWorkflowSession } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/agent-host/recovery.ts"))});
			const recovered = await recoverWorkflowSession(${JSON.stringify(f.repo)}, "change", ${JSON.stringify(f.run.id)});
			const { hostRetryTargetFor } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/agent-host/retry-authority.ts"))});
			console.log(JSON.stringify({ ...recovered, retryAuthorityAvailable: !!hostRetryTargetFor(recovered.runId, recovered.conversationId) }));
		}
	`,
	);
	const child = Bun.spawn([process.execPath, driver], {
		env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const output = await new Response(child.stdout).text();
		const error = await new Response(child.stderr).text();
		expect(await child.exited, error).toBe(0);
		expect(JSON.parse(output).conversationId).toBe(ensured.conversationId);
		expect(JSON.parse(output).retryAuthorityAvailable).toBe(true);
		expect(
			(await new HostClient(f.layout.socketPath).status(f.run.id)).status,
		).toBe("idle");
	} finally {
		child.kill();
		try {
			await new HostClient(f.layout.socketPath).shutdown();
		} catch {
			/* startup failure */
		}
	}
}, 20_000);
