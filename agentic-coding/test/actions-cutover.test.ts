// Cutover, adoption and history (`port-action-execution-to-bun`, tasks 4.4/4.5).
//
// The switch is quiescent: a restarted Bun owner has no live runs and no process
// handles, history stays readable, and a run keeps the registry version and
// definition snapshot it started under no matter how often the configuration is
// reloaded underneath it.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionDefinition } from "@devenv/types";
import {
	type ActionRouteContext,
	type ActionRouteServices,
	createActionRouteContext,
	handleActionRoute,
	rebuildDefinitions,
} from "../src/server/actions/routes.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";

interface Fixture {
	root: string;
	configDir: string;
	homeDir: string;
	store: EnvironmentStateStore;
	services: ActionRouteServices;
	context: ActionRouteContext;
}

function fixture(overrides: Partial<ActionRouteServices> = {}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-cutover-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	const files: Record<string, string> = {
		"apps/compose/shop-compose.yml": "services: {}\n",
		"apps/run/shop-dev.sh":
			"# devenv:name=Dev server\n# devenv:mode=tmux\n#!/bin/sh\necho dev\n",
		"apps/run/shop-fail.sh": "#!/bin/sh\necho boom >&2\nexit 3\n",
		"apps/run/worker-dev.sh": "#!/bin/sh\necho worker\n",
	};
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(configDir, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, { mode: 0o755 });
	}
	fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
	const store = EnvironmentStateStore.open(path.join(homeDir, "db"));
	const apps = [
		{ ident: "shop", localDirectoryPath: root },
		{ ident: "worker", localDirectoryPath: root },
	];
	const services: ActionRouteServices = {
		configDir,
		homeDir,
		apps: {
			getAppByIdent: (ident) => apps.find((a) => a.ident === ident),
			getApps: () => apps,
		},
		infraServices: [],
		state: store as unknown as ActionRouteServices["state"],
		publish: () => {},
		tools: () => ({
			docker: true,
			podman: true,
			dockerCompose: true,
			podmanCompose: true,
			tmux: true,
			kind: true,
			kubectl: true,
			helm: true,
		}),
		tempDir: path.join(root, "tmp"),
		...overrides,
	};
	return {
		root,
		configDir,
		homeDir,
		store,
		services,
		context: createActionRouteContext(services),
	};
}

async function call(
	context: ActionRouteContext,
	method: string,
	url: string,
	body?: unknown,
): Promise<Response> {
	const request = new Request(`http://127.0.0.1${url}`, {
		method,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "content-type": "application/json" },
				}),
	});
	const response = await handleActionRoute(
		context,
		request,
		new URL(request.url),
	);
	if (!response) throw new Error(`no route for ${method} ${url}`);
	return response;
}

async function startRun(
	context: ActionRouteContext,
	actionId: string,
): Promise<string> {
	const response = await call(context, "POST", "/api/action-runs", {
		actionId,
	});
	if (response.status !== 202) {
		throw new Error(`run refused: ${response.status} ${await response.text()}`);
	}
	const { runId } = (await response.json()) as { runId: string };
	for (let i = 0; i < 250; i++) {
		const run = context.runs.get(runId);
		if (run && run.status !== "active") return runId;
		await Bun.sleep(20);
	}
	throw new Error(`run ${runId} did not finish`);
}

describe("quiescent cutover", () => {
	test("a restarted owner starts with no live runs and no process handles", async () => {
		const first = fixture();
		await rebuildDefinitions(first.services, first.context.registry);
		const runId = await startRun(
			first.context,
			"app/shop/action/run/command-shell/dev",
		);
		expect(first.context.runs.get(runId)?.status).toBe("completed");
		// The first owner's process store is empty once the run settled.
		expect(first.context.processes.get("shop")).toBeUndefined();

		// "Restart": a new context over the same on-disk state.
		const second = createActionRouteContext(first.services);
		expect(second.runs.all()).toEqual([]);
		expect(second.runs.active()).toEqual([]);
		// History written by the previous owner is intact and readable.
		const history = await call(second, "GET", "/api/actions/history");
		const events = (await history.json()) as Array<{ type: string }>;
		expect(events.map((e) => e.type)).toContain("action.started");
		expect(events.map((e) => e.type)).toContain("action.completed");
	});

	test("a run is never reparented: cancelling the new owner leaves old runs alone", async () => {
		const first = fixture();
		await rebuildDefinitions(first.services, first.context.registry);
		// A run started by the "old" owner that never completed.
		first.context.runs.start(
			{
				id: "action-old",
				title: "Old",
				appIdent: "shop",
				status: "active",
				steps: [],
			},
			"shop",
			"build",
		);
		const second = createActionRouteContext(first.services);
		await rebuildDefinitions(second.services, second.registry);
		const cancelled = await call(second, "POST", "/api/actions/cancel", {
			ident: "shop",
		});
		expect(await cancelled.json()).toEqual({ success: true });
		// The new owner had nothing to cancel, and it cannot reach the old
		// in-memory run — no live handle is transferred.
		expect(second.runs.get("action-old")).toBeUndefined();
		expect(first.context.runs.get("action-old")?.status).toBe("active");
	});

	test("a cancel reaches the executing step of the current owner", async () => {
		const f = fixture();
		const configDir = f.configDir;
		fs.writeFileSync(
			path.join(configDir, "apps", "run", "shop-dev.sh"),
			"#!/bin/sh\nsleep 30\n",
			{ mode: 0o755 },
		);
		await rebuildDefinitions(f.services, f.context.registry);
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await started.json()) as { runId: string };
		await Bun.sleep(150);
		await call(f.context, "POST", "/api/actions/cancel", { ident: "shop" });
		for (let i = 0; i < 250; i++) {
			const run = f.context.runs.get(runId);
			if (run && run.status === "canceled") break;
			await Bun.sleep(20);
		}
		expect(f.context.runs.get(runId)?.status).toBe("canceled");
	});
});

describe("reload during a run", () => {
	test("the active run and its history keep their version and snapshot", async () => {
		const f = fixture();
		const first = await rebuildDefinitions(f.services, f.context.registry);
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await started.json()) as { runId: string };
		const active = f.context.runs.get(runId);
		expect(active?.registryVersion).toBe(first.version);

		// The configuration changes and a reload publishes a new version.
		fs.writeFileSync(
			path.join(f.configDir, "apps", "run", "shop-extra.sh"),
			"#!/bin/sh\ntrue\n",
			{ mode: 0o755 },
		);
		const second = await rebuildDefinitions(f.services, f.context.registry);
		expect(second.version).toBe(first.version + 1);
		expect(second.get("app/shop/action/run/command-shell/extra")).toBeDefined();

		// The run the previous version started is unchanged.
		const after = f.context.runs.get(runId);
		expect(after?.registryVersion).toBe(first.version);
		expect(
			after?.definitionSnapshot?.root.children?.map((c) => c.label),
		).not.toContain("extra");
		for (let i = 0; i < 250; i++) {
			if (f.context.runs.get(runId)?.status !== "active") break;
			await Bun.sleep(20);
		}
		// The historical view is still the same run.
		expect(f.context.runs.get(runId)?.registryVersion).toBe(first.version);
	});

	test("a state written before the reload stays readable through the API", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const runId = await startRun(
			f.context,
			"app/shop/action/run/command-shell/dev",
		);
		await rebuildDefinitions(f.services, f.context.registry);
		const logs = await call(
			f.context,
			"GET",
			`/api/actions/logs?runId=${runId}`,
		);
		expect(logs.status).toBe(200);
		const history = await call(
			f.context,
			"GET",
			"/api/actions/history?scope=all",
		);
		const events = (await history.json()) as Array<{ type: string }>;
		expect(events.length).toBeGreaterThan(0);
	});
});

describe("dependency sharing across runs", () => {
	test("a dependency is compiled into each run's own tree, executed per run", async () => {
		const f = fixture();
		// The infra service the app depends on, plus the compose header that names
		// it: the dependency becomes a step in the compiled definition.
		fs.writeFileSync(
			path.join(f.configDir, "apps", "compose", "shop-compose.yml"),
			'x-devenv:\n  requires: [{"infra":"postgres"}]\nservices: {}\n',
		);
		const withInfra: ActionRouteServices = {
			...f.services,
			infraServices: [
				{
					ident: "postgres",
					displayName: "Postgres",
					type: "docker",
				},
			],
		};
		const context = createActionRouteContext(withInfra);
		await rebuildDefinitions(withInfra, context.registry);
		const definition = context.registry
			.snapshot()
			.get("app/shop/action/run/docker/default") as ActionDefinition;
		const dependency = definition.root.children?.find((c) =>
			c.id.includes("/step/dependency/"),
		);
		expect(dependency?.executionKey).toBe("dependency/postgres");
		expect(dependency?.children?.map((c) => c.kind)).toContain("readiness");
	});
});

describe("failure cleanup", () => {
	test("a failing command fails the run and leaves its output in the log", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const runId = await startRun(
			f.context,
			"app/shop/action/run/command-shell/fail",
		);
		const run = f.context.runs.get(runId);
		expect(run?.status).toBe("failed");
		const step = run?.steps.find((s) => s.id.endsWith("/execute"));
		expect(step?.status).toBe("failed");
		expect(step?.error).toContain("exit status 3");
		const logs = f.context.services.state.getActionLogEvents(runId, "", 50000);
		expect(logs.join("")).toContain("boom");
	});
});

describe("SDK-only operations stay commandless", () => {
	test("an operation step runs through the adapter with no command record", async () => {
		const dispatched: Array<{ operation: string; owner: unknown }> = [];
		const f = fixture({
			runtime: {
				execute: async (request) => {
					dispatched.push({
						operation: request.operation,
						owner: request.owner,
					});
					return { ok: true, output: "restarted" };
				},
			},
		});
		await rebuildDefinitions(f.services, f.context.registry);
		// Compile a definition whose leaf is an SDK-only operation.
		const definition: ActionDefinition = {
			id: "infra/postgres/action/start/docker/default",
			owner: { kind: "infrastructure", id: "postgres" },
			type: "start",
			runtime: "docker",
			label: "Start Postgres",
			inputs: [],
			availability: { available: true },
			root: {
				id: "root",
				kind: "composite",
				label: "Start Postgres",
				children: [
					{
						id: "start",
						kind: "operation",
						label: "Start Postgres",
						configuration: {
							operation: "docker.container.start",
							containerId: "abc",
						},
					},
				],
			},
		};
		// Publish the definition through a provider so the run bridge can find it.
		await f.context.registry.rebuild([
			{ name: "test", compile: () => [definition] },
		]);
		const runId = await startRun(
			f.context,
			"infra/postgres/action/start/docker/default",
		);
		const run = f.context.runs.get(runId);
		expect(run?.status).toBe("completed");
		expect(dispatched[0]?.operation).toBe("docker.container.start");
		expect(dispatched[0]?.owner).toMatchObject({
			runId,
			stepId: "start",
			commandId: "start-command-0",
		});
		// No command was fabricated: the step owns no command and the log has no
		// command events for it.
		const step = run?.steps.find((s) => s.id === "start");
		expect(step?.commands).toEqual([]);
		const logs = f.context.services.state.getActionLogEvents(runId, "", 50000);
		expect(logs.join("")).not.toContain("command.started");
	});

	test("with no adapter the operation fails loudly instead of reporting success", async () => {
		const f = fixture();
		await f.context.registry.rebuild([
			{
				name: "test",
				compile: () => [
					{
						id: "infra/postgres/action/start/docker/default",
						owner: { kind: "infrastructure", id: "postgres" },
						type: "start",
						runtime: "docker",
						label: "Start Postgres",
						inputs: [],
						availability: { available: true },
						root: {
							id: "root",
							kind: "composite",
							label: "Start Postgres",
							children: [
								{
									id: "start",
									kind: "operation",
									label: "Start Postgres",
									configuration: { operation: "docker.container.start" },
								},
							],
						},
					},
				],
			},
		]);
		const runId = await startRun(
			f.context,
			"infra/postgres/action/start/docker/default",
		);
		const run = f.context.runs.get(runId);
		expect(run?.status).toBe("failed");
		expect(run?.steps.find((s) => s.id === "start")?.error).toMatch(
			/no runtime adapter for operation/,
		);
	});
});
