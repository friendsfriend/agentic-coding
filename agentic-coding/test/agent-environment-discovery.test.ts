// The environment capability's discovery handoff (fix-env-tools-for-all-runs):
// a process that is NOT the unified server — the workflow CLI's start/drain, the
// per-repository agent host, a workflow of another repository — still hands its
// runs the owner-scoped capability of the running server, discovered from the
// record the server publishes under the configuration root. A stale, foreign or
// readable-by-others record is ignored, and a process with no server anywhere
// launches runs with no capability and says so.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	clearEnvironmentServer,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	ensureEnvironmentServer,
	environmentOwnerFor,
	environmentRunEnv,
	publishEnvironmentServer,
	resetEnvironmentServerDiscovery,
} from "../src/agent-host/environment-capability.ts";
import type { Assignment } from "../src/contracts/workflow.ts";
import { environmentTokenFor } from "../src/server/auth.ts";
import type { EnvironmentAuthority } from "../src/server/environment/private-api.ts";
import {
	environmentDiscoveryFile,
	publishEnvironmentDiscovery,
} from "../src/server/environment-discovery.ts";
import type { IntegrationServices } from "../src/server/integrations/routes.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { renderAssignment } from "../src/workflow/assignment.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

const CONFIG_ROOT_VAR = "AGENTIC_CODING_CONFIG_DIR";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	resetEnvironmentServerDiscovery();
});

function track(cleanup: () => void): void {
	cleanups.push(cleanup);
}

/** A configuration root of this test's own: the discovery record is published
 * under the resolved root, so the environment variable is what makes a process
 * resolve the same one. */
function configRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-discovery-config-"));
	const previous = process.env[CONFIG_ROOT_VAR];
	process.env[CONFIG_ROOT_VAR] = dir;
	track(() => {
		if (previous === undefined) delete process.env[CONFIG_ROOT_VAR];
		else process.env[CONFIG_ROOT_VAR] = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

/** A pid that is certainly gone: a process this test waited for. */
function deadPid(): number {
	const child = Bun.spawnSync(["true"]);
	let pid = child.pid;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			process.kill(pid, 0);
		} catch {
			return pid;
		}
		// The very unlikely reused pid: take another one that never existed as a
		// process of this user.
		pid = 30_000 + attempt;
	}
	throw new Error("could not find a dead pid");
}

/** A loopback port nothing listens on any more. */
async function closedPort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("ok"),
	});
	const port = probe.port ?? 0;
	await probe.stop(true);
	return port;
}

/** A server that serves its configuration root's agent environment surface:
 * the discovery record is published by exactly such a server, so a run of
 * another process can act through it. */
async function startServer(configDir: string) {
	const server = await startWorkflowServer({
		port: 0,
		configDir,
		environment: {
			manager: {
				getApps: () => [],
				getAppByIdent: () => undefined,
				getInfraServices: () => [],
			},
		} as unknown as EnvironmentAuthority,
		integrations: {
			instances: { startIdleReaper: () => () => {} },
		} as unknown as IntegrationServices,
	});
	track(() => void server.stop());
	return server;
}

/** A git checkout the env-setup start guard accepts (clean, on a named branch). */
function repository(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "env-discovery-repo-"));
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

/** Start the env-setup family in one repository and answer with its snapshot. */
function startEnvSetup(repo: string, workflowId: string) {
	const engine = new WorkflowEngine(registerBuiltins());
	const started = engine.start({
		repo,
		workflowId,
		definitionId: "env-setup",
		definitionVersion: definitionVersionForFamilyTraits(6),
		mode: "checkout",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			app: "shop",
			setupDraftsDir: path.join(
				os.tmpdir(),
				"env-discovery-drafts",
				workflowId,
			),
		},
		routing: { defaultProfile: "test", routes: [], diversity: [] },
	} as never);
	track(() => fs.rmSync(canonicalRepo(repo), { recursive: true, force: true }));
	return started.snapshot;
}

/** The store directory the engine created beside the repository. */
function canonicalRepo(repo: string): string {
	return path.join(repo, ".herdr-workflow");
}

describe("environment server discovery", () => {
	test("a run launched outside the server process receives the server's owner-scoped capability", async () => {
		const dir = configRoot();
		const server = await startServer(dir);
		try {
			// The record carries the endpoint, so any process that reads the
			// configuration root can find the server it must talk to.
			const file = environmentDiscoveryFile(dir);
			expect(fs.existsSync(file)).toBe(true);
			// The instance token is a secret: only its owner may read the record.
			expect(fs.statSync(file).mode & 0o077).toBe(0);

			// Simulate the other process: nothing published in this one.
			clearEnvironmentServer(server.token);
			expect(await ensureEnvironmentServer()).not.toBeUndefined();
			const env = environmentRunEnv("wf-alpha");
			expect(env[ENVIRONMENT_URL_ENV]).toBe(server.url);
			expect(env[ENVIRONMENT_TOKEN_ENV]).toBe(
				environmentTokenFor(server.token, environmentOwnerFor("wf-alpha")),
			);
			// One owner's capability is never another owner's.
			expect(environmentRunEnv("wf-beta")[ENVIRONMENT_TOKEN_ENV]).not.toBe(
				env[ENVIRONMENT_TOKEN_ENV],
			);
		} finally {
			publishEnvironmentServer({ url: server.url, token: server.token });
			await server.stop();
		}
	});

	test("the record is removed when the server stops", async () => {
		const dir = configRoot();
		const server = await startServer(dir);
		const file = environmentDiscoveryFile(dir);
		expect(fs.existsSync(file)).toBe(true);
		await server.stop();
		expect(fs.existsSync(file)).toBe(false);
		expect(await ensureEnvironmentServer(dir)).toBeUndefined();
	});

	test("a process with no server anywhere launches runs with no capability", async () => {
		const dir = configRoot();
		expect(await ensureEnvironmentServer()).toBeUndefined();
		expect(environmentRunEnv("wf-alpha")).toEqual({});
		expect(fs.existsSync(environmentDiscoveryFile(dir))).toBe(false);
	});

	test("a discovered server is used only under the configuration root it was published in", async () => {
		const dir = configRoot();
		const server = await startServer(dir);
		try {
			clearEnvironmentServer(server.token);
			expect(await ensureEnvironmentServer()).not.toBeUndefined();
			expect(environmentRunEnv("wf-alpha")[ENVIRONMENT_URL_ENV]).toBe(
				server.url,
			);
			// The same process resolving another root gets no capability at all: a
			// run is never handed one derived for a configuration it does not serve.
			const other = fs.mkdtempSync(
				path.join(os.tmpdir(), "env-discovery-other-"),
			);
			track(() => fs.rmSync(other, { recursive: true, force: true }));
			process.env[CONFIG_ROOT_VAR] = other;
			expect(environmentRunEnv("wf-alpha")).toEqual({});
		} finally {
			publishEnvironmentServer({ url: server.url, token: server.token });
			await server.stop();
		}
	});

	test("a record left behind by a process that is gone is ignored", async () => {
		const dir = configRoot();
		publishEnvironmentDiscovery(dir, {
			url: "http://127.0.0.1:1",
			token: "stale-token",
			instance: "stale-instance",
			pid: deadPid(),
		});
		expect(await ensureEnvironmentServer(dir)).toBeUndefined();
		expect(environmentRunEnv("wf-alpha")).toEqual({});
	});

	test("a record whose server does not answer is ignored", async () => {
		const dir = configRoot();
		publishEnvironmentDiscovery(dir, {
			url: `http://127.0.0.1:${await closedPort()}`,
			token: "dead-token",
			instance: "dead-instance",
			pid: process.pid,
		});
		expect(await ensureEnvironmentServer(dir)).toBeUndefined();
	});

	test("a record the server did not write (readable by others, or naming another instance) is ignored", async () => {
		const dir = configRoot();
		const server = await startServer(dir);
		try {
			const file = environmentDiscoveryFile(dir);
			// A record any other user can read is refused rather than trusted.
			const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
				string,
				unknown
			>;
			fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
			fs.chmodSync(file, 0o644);
			expect((fs.statSync(file).mode & 0o077) !== 0).toBe(true);
			clearEnvironmentServer(server.token);
			expect(await ensureEnvironmentServer(dir)).toBeUndefined();

			// A record that names another instance is not this server, even though
			// the port answers.
			publishEnvironmentDiscovery(dir, {
				url: server.url,
				token: server.token,
				instance: "someone-else",
				pid: process.pid,
			});
			expect(await ensureEnvironmentServer(dir)).toBeUndefined();
			expect(environmentRunEnv("wf-alpha")).toEqual({});
		} finally {
			publishEnvironmentServer({ url: server.url, token: server.token });
			await server.stop();
		}
	});
});

describe("a run without an environment capability is told so", () => {
	function assignment(environment: Record<string, string>): Assignment {
		return {
			protocolVersion: 1,
			workflowId: "wf-alpha",
			runId: "run-1",
			generation: 1,
			stepId: "setup.author",
			role: "env-setup",
			objective: "Author environment drafts.",
			interaction: "silent",
			inputs: [],
			permissions: ["read"],
			checks: [],
			allowedOutcomes: ["complete", "blocked", "failed"],
			environment: environment as Assignment["environment"],
		};
	}

	test("the assignment states that the environment tools are unavailable", () => {
		const step = registerBuiltins().step("setup.author", 1);
		const prompt = renderAssignment(
			step,
			assignment({ HERDR_WORKFLOW_ID: "wf-alpha" }),
		).prompt;
		expect(prompt).toContain("## Environment tools: unavailable");
		expect(prompt).toContain("`env_start`");
		expect(prompt).toContain(
			"No agentic-coding server was reachable for this run's configuration",
		);
	});

	test("an assignment that carries the capability says nothing of the kind", () => {
		const step = registerBuiltins().step("setup.author", 1);
		const prompt = renderAssignment(
			step,
			assignment({
				HERDR_WORKFLOW_ID: "wf-alpha",
				[ENVIRONMENT_URL_ENV]: "http://127.0.0.1:4050",
				[ENVIRONMENT_TOKEN_ENV]: "capability",
			}),
		).prompt;
		expect(prompt).not.toContain("Environment tools: unavailable");
	});

	test("an env-setup start without a server records it in the workflow's own health", () => {
		configRoot();
		const withoutServer = startEnvSetup(repository(), "wf-env-no-server");
		expect(
			withoutServer.attention.some((entry) =>
				entry.includes("env-setup has no environment capability"),
			),
		).toBe(true);
	});

	test("an env-setup start that can reach a server stays attention-free", async () => {
		const dir = configRoot();
		const server = await startServer(dir);
		try {
			clearEnvironmentServer(server.token);
			await ensureEnvironmentServer();
			const withServer = startEnvSetup(repository(), "wf-env-with-server");
			expect(
				withServer.attention.filter((entry) =>
					entry.includes("no environment capability"),
				),
			).toEqual([]);
		} finally {
			publishEnvironmentServer({ url: server.url, token: server.token });
			await server.stop();
		}
	});
});
