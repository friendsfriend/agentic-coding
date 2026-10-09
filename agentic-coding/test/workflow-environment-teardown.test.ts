// The owner-bound `environment.teardown` effect
// (`add-environment-instance-lifecycle`).
//
// A workflow releases the apps it holds through one durable outbox effect: the
// close hook emits it, the runner executes it against the environment server,
// and the delete path drains it before the workflow's rows (and its outbox) go.
// This file drives the real step behavior, the real handler and the real
// application boundary; the controller's own release path is covered by
// `environment-instance-lifecycle.test.ts`.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	EffectKind,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	DockerClient,
	type DockerRuntime,
	type DockerRuntimeSelection,
} from "../src/server/runtime/docker.ts";
import {
	EnvironmentInstanceController,
	EnvironmentInstanceError,
} from "../src/server/runtime/instances.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { deleteWorkflow } from "../src/workflow/operations.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import { lifecycleBehaviors } from "../src/workflow/steps/lifecycle.ts";

const RUNTIME: DockerRuntime = {
	name: "docker",
	command: "docker",
	host: "unix:///var/run/docker.sock",
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track(cleanup: () => void | Promise<void>): void {
	cleanups.push(cleanup);
}

function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teardown-repo-"));
	fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"init",
		],
		{ cwd: root },
	);
	track(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

/** Start one durable workflow that can be closed and deleted. */
function start(
	workflowEngine: WorkflowEngine,
	root: string,
	workflowId: string,
) {
	const profile = {
		name: "test",
		runtime: "pi-durable" as const,
		executable: "sh",
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"] as const,
		digest: "profile",
	};
	return workflowEngine.start({
		repo: root,
		workflowId,
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "task",
		},
		routing: {
			defaultProfile: "test",
			routes: [{ stepId: "core.implementation", role: "worker", profile }],
			diversity: [],
		},
	});
}

/** The recorded teardown row of one workflow. */
function teardownRow(
	root: string,
	workflowId: string,
): { kind: string; idempotency_key: string; payload_json: string } | null {
	const db = new Database(canonicalStorePath(root));
	try {
		return db
			.query(
				"SELECT kind, idempotency_key, payload_json FROM workflow_outbox WHERE workflow_id=? AND kind='environment.teardown'",
			)
			.get(workflowId) as {
			kind: string;
			idempotency_key: string;
			payload_json: string;
		} | null;
	} finally {
		db.close();
	}
}

/** A kind-scoped runner: the teardown effect only, never the workflow's other
 * pending work. */
function teardownRunner(
	workflowEngine: WorkflowEngine,
	root: string,
): EffectRunner {
	return new EffectRunner(
		root,
		workflowEngine,
		agentEffectHandlers(root, workflowEngine, {
			registry: registerBuiltins(),
			adapters: new Map(),
		}),
		{ claimKind: "environment.teardown" satisfies EffectKind },
	);
}

/** One real environment server whose teardown is the given callback. */
async function server(stopByOwner: (owner: string) => Promise<unknown>) {
	const started = await startWorkflowServer({
		port: 0,
		ownTelemetry: false,
		integrations: {
			instances: {
				stopByOwner,
				// The server owns the reaper; this fake has no slots to reap.
				startIdleReaper: () => () => {},
			},
		} as never,
	});
	track(() => started.stop());
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	const previousToken = process.env.AGENTIC_WORKFLOW_TOKEN;
	process.env.AGENTIC_WORKFLOW_URL = started.url;
	process.env.AGENTIC_WORKFLOW_TOKEN = started.token;
	track(() => {
		if (previousUrl === undefined) delete process.env.AGENTIC_WORKFLOW_URL;
		else process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		if (previousToken === undefined) delete process.env.AGENTIC_WORKFLOW_TOKEN;
		else process.env.AGENTIC_WORKFLOW_TOKEN = previousToken;
	});
	return started;
}

describe("the close hook", () => {
	test("enqueues the durable owner teardown alongside the workspace close", () => {
		const enqueued: Array<{ kind: string; key: string; payload: unknown }> = [];
		lifecycleBehaviors["core.closed"]?.onEnter?.({
			snapshot: { workflowId: "wf-1" } as WorkflowSnapshot,
			enqueue: (kind: string, key: string, payload: unknown) =>
				enqueued.push({ kind, key, payload }),
		} as never);
		expect(enqueued).toEqual([
			{
				kind: "workspace.close",
				key: "workspace:wf-1:close",
				payload: { workflowId: "wf-1" },
			},
			{
				kind: "environment.teardown",
				key: "environment:wf-1:teardown",
				payload: { workflowId: "wf-1", owner: "workflow:wf-1" },
			},
		]);
	});
});

describe("the teardown effect", () => {
	test("an unreachable environment server is retried, never recorded as a release", async () => {
		const root = repo();
		const workflowEngine = new WorkflowEngine(registerBuiltins());
		start(workflowEngine, root, "unreachable");
		workflowEngine.enqueueEffect(
			root,
			"unreachable",
			"environment.teardown",
			"environment:unreachable:teardown",
			{ workflowId: "unreachable", owner: "workflow:unreachable" },
		);
		// A server that is not listening: the client resolves, the request cannot.
		const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
		const previousToken = process.env.AGENTIC_WORKFLOW_TOKEN;
		process.env.AGENTIC_WORKFLOW_URL = "http://127.0.0.1:1";
		process.env.AGENTIC_WORKFLOW_TOKEN = "token";
		try {
			await teardownRunner(workflowEngine, root).drain();
			const effect = workflowEngine
				.status(root, "unreachable")
				.effects.find((entry) => entry.kind === "environment.teardown");
			// Retryable: the outbox owns the attempt accounting, so the durable
			// effect — not a one-off call — is what a later drain resumes.
			expect(effect?.status).toBe("retry");
			expect(effect?.attempts).toBe(1);
			expect(effect?.lastError).toBeTruthy();
		} finally {
			if (previousUrl === undefined) delete process.env.AGENTIC_WORKFLOW_URL;
			else process.env.AGENTIC_WORKFLOW_URL = previousUrl;
			if (previousToken === undefined)
				delete process.env.AGENTIC_WORKFLOW_TOKEN;
			else process.env.AGENTIC_WORKFLOW_TOKEN = previousToken;
		}
	});

	test("records one release, and never a second one", async () => {
		const root = repo();
		const workflowEngine = new WorkflowEngine(registerBuiltins());
		start(workflowEngine, root, "released");
		workflowEngine.enqueueEffect(
			root,
			"released",
			"environment.teardown",
			"environment:released:teardown",
			{ workflowId: "released", owner: "workflow:released" },
		);
		const owners: string[] = [];
		await server(async (owner) => {
			owners.push(owner);
			return { owner, apps: ["customer-mw"] };
		});

		const runner = teardownRunner(workflowEngine, root);
		await runner.drain();
		const effect = workflowEngine
			.status(root, "released")
			.effects.find((entry) => entry.kind === "environment.teardown");
		expect(effect?.status).toBe("completed");
		expect(effect?.attempts).toBe(1);
		expect(owners).toEqual(["workflow:released"]);

		// A second drain finds nothing to claim: the release is recorded once.
		await runner.drain();
		expect(owners).toEqual(["workflow:released"]);
	});

	test("a process with no environment server reports the release as not done", async () => {
		const root = repo();
		const workflowEngine = new WorkflowEngine(registerBuiltins());
		start(workflowEngine, root, "detached");
		workflowEngine.enqueueEffect(
			root,
			"detached",
			"environment.teardown",
			"environment:detached:teardown",
			{ workflowId: "detached", owner: "workflow:detached" },
		);
		// No retry can attach a transport, so this is permanent instead of
		// consuming the transient retry budget.
		await teardownRunner(workflowEngine, root).drain();
		const effect = workflowEngine
			.status(root, "detached")
			.effects.find((entry) => entry.kind === "environment.teardown");
		expect(effect?.status).toBe("failed");
		expect(effect?.lastError).toContain("no environment server");
	});
});

describe("deleting a workflow", () => {
	test("releases the apps its owner holds before its rows go", async () => {
		const root = repo();
		const configRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "teardown-config-"),
		);
		track(() => fs.rmSync(configRoot, { recursive: true, force: true }));
		const configDir = path.join(configRoot, "config");
		const checkout = path.join(configRoot, "checkout");
		fs.mkdirSync(path.join(configDir, "apps", "compose"), { recursive: true });
		fs.mkdirSync(checkout, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, "apps", "compose", "customer-mw-compose.yml"),
			`services:\n  web:\n    container_name: customer-mw-web\n    image: "mw:latest"\n`,
		);
		const state = EnvironmentStateStore.open(path.join(configRoot, "db"));
		track(() => state.close());
		const commands: string[][] = [];
		const controller = new EnvironmentInstanceController({
			state,
			apps: () => [
				{
					ident: "customer-mw",
					displayName: "customer-mw",
					repositoryPath: "https://example.com/mw",
					appType: "app",
					localDirectoryPath: checkout,
					branch: "main",
				},
			],
			configDir,
			docker: {
				runtime: RUNTIME,
				client: new DockerClient(RUNTIME, {
					fetch: (async (input: RequestInfo | URL) => {
						const url = new URL(String(input));
						if (url.pathname === "/containers/json") return Response.json([]);
						return new Response("no route", { status: 404 });
					}) as unknown as typeof fetch,
				}),
				fallbacks: [],
			} satisfies DockerRuntimeSelection,
			resolveOwnerCheckout: () => checkout,
			observeRun: async (candidate) =>
				state.findActiveEnvironmentInstance(candidate.ident)
					? "running"
					: "stopped",
			runCommand: async (_command, args) => {
				commands.push([...args]);
				return { exitCode: 0, output: "" };
			},
			logger: () => {},
		});
		await controller.ready;
		// The run the workflow holds was started through the controller, so its
		// target and checkout are the ones a real release has to stop.
		await controller.acquire({
			owner: "workflow:deleted",
			apps: ["customer-mw"],
			waitSec: 1,
		});
		expect(
			state.findEnvironmentInstance("workflow:deleted", "customer-mw")?.status,
		).toBe("running");

		const workflowEngine = new WorkflowEngine(registerBuiltins());
		start(workflowEngine, root, "deleted");
		// The server the effect talks to is this very controller, so the release
		// goes through the real stop path.
		await server((owner) => controller.stopByOwner(owner));

		const deletion = await deleteWorkflow(root, "deleted");

		expect(deletion.teardownError).toBeUndefined();
		expect(state.findActiveEnvironmentInstance("customer-mw")).toBeUndefined();
		expect(commands.some((args) => args.includes("down"))).toBe(true);
		// The rows are gone with the workflow, and its outbox with them.
		expect(() => workflowEngine.status(root, "deleted")).toThrow();
		expect(teardownRow(root, "deleted")).toBeNull();
	});

	test("reports a release the environment server refused", async () => {
		const root = repo();
		const workflowEngine = new WorkflowEngine(registerBuiltins());
		start(workflowEngine, root, "unreleased");
		await server(async () => {
			throw new EnvironmentInstanceError(
				"teardown-failed",
				400,
				"the server refused the teardown",
			);
		});

		const deletion = await deleteWorkflow(root, "unreleased");

		// The delete still happens — the rows and the worktree policy are not
		// held hostage by an environment server — but the release is not claimed.
		expect(deletion.teardownError).toContain("refused");
		expect(() => workflowEngine.status(root, "unreleased")).toThrow();
	});
});
