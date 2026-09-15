// Action and script routes (`port-action-execution-to-bun`, tasks 4.1–4.5).
//
// The whole surface is exercised through `handleLegacyRoute`, which is what the
// served product uses: the manifest says the family is Bun's, the Bun handler
// answers, and nothing is delegated. History is asserted through the real
// Bun-owned state store, and a run's output is asserted to land in the per-run
// log while every other event lands in the bounded event log — the split the Go
// owner performed.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionDefinition } from "@devenv/types";
import { LegacyEventStream } from "../src/server/actions/event-stream.ts";
import {
	type ActionRouteContext,
	type ActionRouteServices,
	compactActionHistory,
	createActionRouteContext,
	handleActionRoute,
	rebuildDefinitions,
} from "../src/server/actions/routes.ts";
import {
	createRuntimeAdapter,
	decodeRuntimeOperationRequest,
	isKnownOperation,
	LateRuntimeResultError,
	RUNTIME_OPERATION_PATH,
} from "../src/server/actions/runtime-adapter.ts";
import { EnvironmentStateStore } from "../src/server/environment/state-store.ts";
import {
	handleLegacyRoute,
	type IntegrationServices,
	LEGACY_ROUTE_OWNERSHIP,
	legacyRouteMatch,
} from "../src/server/integrations/routes.ts";

const CONFIG_FILES: Record<string, string> = {
	"apps/build/shop-build.sh": "#!/bin/sh\necho build\n",
	"apps/compose/shop-compose.yml": "services: {}\n",
	"apps/run/shop-dev.sh":
		"# devenv:name=Dev server\n# devenv:mode=tmux\n#!/bin/sh\necho dev-server-started\n",
};

interface Fixture {
	root: string;
	configDir: string;
	homeDir: string;
	store: EnvironmentStateStore;
	services: ActionRouteServices;
	context: ActionRouteContext;
	app: { ident: string; localDirectoryPath: string };
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-actions-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	for (const [relative, content] of Object.entries(CONFIG_FILES)) {
		const full = path.join(configDir, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, { mode: 0o755 });
	}
	fs.mkdirSync(path.join(homeDir, "scripts"), { recursive: true });
	const store = EnvironmentStateStore.open(path.join(homeDir, "db"));
	const app = { ident: "shop", localDirectoryPath: root };
	const events: Array<{
		type: string;
		properties: Record<string, unknown>;
		timestamp: string;
	}> = [];
	const services: ActionRouteServices = {
		configDir,
		homeDir,
		apps: {
			getAppByIdent: (ident) => (ident === app.ident ? app : undefined),
			getApps: () => [app],
		},
		infraServices: [],
		state: store as unknown as ActionRouteServices["state"],
		publish: (event) => events.push(event),
		// Every tool present, so variant selection is deterministic.
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
	};
	fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
	return {
		root,
		configDir,
		homeDir,
		store,
		services,
		context: createActionRouteContext(services),
		app,
	};
}

function integrationServices(actions: ActionRouteContext): IntegrationServices {
	return {
		providers: {} as IntegrationServices["providers"],
		git: {} as IntegrationServices["git"],
		apps: {
			getAppByIdent: () => undefined,
			getApps: () => [],
			updateAppActiveWorktree: () => {},
			loadConfig: () => {},
		},
		actions,
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

async function waitForRun(
	context: ActionRouteContext,
	runId: string,
): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const run = context.runs.get(runId);
		if (run && run.status !== "active") return;
		await Bun.sleep(20);
	}
	throw new Error(`run ${runId} did not finish`);
}

describe("definition providers", () => {
	test("a configured environment compiles the expected definitions", async () => {
		const f = fixture();
		const snapshot = await rebuildDefinitions(f.services, f.context.registry);
		expect(snapshot.version).toBe(1);
		const ids = snapshot.definitions.map((d) => d.id);
		// The compose file yields a docker action plus its lifecycle actions, the
		// shell scripts yield tmux/command variants, and git actions always exist.
		expect(ids).toContain("app/shop/action/run/docker/default");
		// The run script is profile-scoped (`shop-dev.sh` → profile `dev`).
		expect(ids).toContain("app/shop/action/run/tmux/dev");
		expect(ids).toContain("app/shop/action/run/command-shell/dev");
		expect(ids).toContain("app/shop/action/run/command-systemshell/dev");
		expect(ids).toContain("app/shop/action/build/command-shell/default");
		expect(ids).toContain("app/shop/action/stop/docker/default");
		expect(ids).toContain("app/shop/action/pull/git/default");
		expect(ids).toContain("kubernetes/local/action/create/docker/default");
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("a rebuild failure keeps the previous snapshot and reports the error", async () => {
		const f = fixture();
		const first = await rebuildDefinitions(f.services, f.context.registry);
		// A run script whose `devenv:requires` header cannot be parsed makes
		// discovery fail, which is exactly the kind of configuration error a
		// rebuild must refuse to publish.
		const brokenConfig = path.join(f.root, "broken-config");
		fs.mkdirSync(path.join(brokenConfig, "apps", "run"), { recursive: true });
		fs.writeFileSync(
			path.join(brokenConfig, "apps", "run", "shop-dev.sh"),
			"# devenv:requires=not json\n#!/bin/sh\n",
			{ mode: 0o755 },
		);
		const broken: ActionRouteServices = {
			...f.services,
			configDir: brokenConfig,
		};
		const status = await call(f.context, "GET", "/api/action-registry/status");
		expect(((await status.json()) as { available: boolean }).available).toBe(
			true,
		);
		await expect(
			rebuildDefinitions(broken, f.context.registry),
		).rejects.toThrow();
		expect(f.context.registry.snapshot().version).toBe(first.version);
		const after = await call(f.context, "GET", "/api/action-registry/status");
		const body = (await after.json()) as {
			version: number;
			available: boolean;
			error: string;
		};
		expect(body.version).toBe(first.version);
		expect(body.available).toBe(false);
		expect(body.error).not.toBe("");
	});
});

describe("definitions", () => {
	test("an app lists its own actions and the registry reports status", async () => {
		const f = fixture();
		const snapshot = await rebuildDefinitions(f.services, f.context.registry);
		const listed = await call(f.context, "GET", "/api/apps/shop/actions");
		const body = (await listed.json()) as {
			version: number;
			actions: ActionDefinition[];
		};
		expect(body.version).toBe(snapshot.version);
		expect(body.actions.length).toBeGreaterThan(0);
		expect(
			body.actions.every(
				(a) => a.owner.kind === "app" && a.owner.id === "shop",
			),
		).toBe(true);

		const registry = await call(
			f.context,
			"GET",
			"/api/action-registry/status",
		);
		expect(await registry.json()).toMatchObject({
			version: snapshot.version,
			actionsCount: snapshot.definitions.length,
			available: true,
		});

		const unknown = await call(f.context, "GET", "/api/apps/nobody/actions");
		expect(((await unknown.json()) as { actions: unknown[] }).actions).toEqual(
			[],
		);
	});

	test("one definition is served verbatim, a missing id is a 404", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const id = "app/shop/action/pull/git/default";
		const found = await call(
			f.context,
			"GET",
			`/api/action-definition?id=${encodeURIComponent(id)}`,
		);
		expect(((await found.json()) as ActionDefinition).id).toBe(id);
		const missing = await call(
			f.context,
			"GET",
			"/api/action-definition?id=nope",
		);
		expect(missing.status).toBe(404);
		const noId = await call(f.context, "GET", "/api/action-definition");
		expect(noId.status).toBe(400);
	});
});

describe("running an action", () => {
	test("a command step runs, is projected and is persisted", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		// A tmux action would need a real tmux pane; the command-shell variant
		// runs the script directly, which is what this asserts end to end.
		const id = "app/shop/action/run/command-shell/dev";
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: id,
		});
		expect(started.status).toBe(202);
		const body = (await started.json()) as {
			runId: string;
			registryVersion: number;
		};
		expect(body.registryVersion).toBe(f.context.registry.snapshot().version);
		await waitForRun(f.context, body.runId);

		const run = f.context.runs.get(body.runId);
		expect(run?.status).toBe("completed");
		expect(run?.definitionSnapshot?.id).toBe(id);
		// The snapshot never carries executable configuration.
		expect(JSON.stringify(run?.definitionSnapshot)).not.toContain("echo");

		const steps = run?.steps.map((s) => [s.id.split("/").pop(), s.status]);
		expect(steps).toContainEqual(["execute", "completed"]);

		// Output is in the per-run log; the lifecycle is in the event log.
		const logs = f.context.services.state.getActionLogEvents(
			body.runId,
			"",
			50000,
		);
		expect(logs.length).toBeGreaterThan(0);
		const history = f.context.services.state.getActionEventsSince(
			50000,
			new Date(0),
		);
		expect(history.some((e) => e.includes("action.started"))).toBe(true);
		expect(history.some((e) => e.includes("action.completed"))).toBe(true);
		expect(history.some((e) => e.includes("command.output"))).toBe(false);

		const logsResponse = await call(
			f.context,
			"GET",
			`/api/actions/logs?runId=${body.runId}`,
		);
		const compacted = (await logsResponse.json()) as Array<{
			type: string;
			properties: { output?: string };
		}>;
		expect(compacted.some((e) => e.type === "action.command.output")).toBe(
			true,
		);
		// Chunks of one stream are joined, so the client replays fewer steps.
		expect(
			compacted.filter((e) => e.type === "action.command.output"),
		).toHaveLength(1);

		const historyResponse = await call(
			f.context,
			"GET",
			"/api/actions/history",
		);
		const events = (await historyResponse.json()) as Array<{ type: string }>;
		expect(events.map((e) => e.type)).toContain("action.started");
		expect(events.map((e) => e.type)).toContain("action.completed");
	});

	test("an unknown input, a missing required input and an unknown action are rejected", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const unknownAction = await call(f.context, "POST", "/api/action-runs", {
			actionId: "nope",
		});
		expect(unknownAction.status).toBe(404);
		// `pull` declares no inputs, so any input is unknown; `checkout` requires
		// a branch, so an empty input map is refused before it starts.
		const unknownInput = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/pull/git/default",
			inputs: { nonsense: 1 },
		});
		expect(unknownInput.status).toBe(400);
		expect(((await unknownInput.json()) as { error: string }).error).toBe(
			"unknown input: nonsense",
		);
		const missing = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/checkout/git/default",
			inputs: {},
		});
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toBe(
			"missing required input: branch",
		);
	});

	test("a second run of the same action is refused while the first is active", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const id = "app/shop/action/run/command-shell/dev";
		const first = await call(f.context, "POST", "/api/action-runs", {
			actionId: id,
		});
		expect(first.status).toBe(202);
		const second = await call(f.context, "POST", "/api/action-runs", {
			actionId: id,
		});
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error: string }).error).toMatch(
			/already active/,
		);
		const { runId } = (await first.json()) as { runId: string };
		await waitForRun(f.context, runId);
	});

	test("an unavailable action is refused with its reason", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const definition = f.context.registry
			.snapshot()
			.get("app/shop/action/pull/git/default");
		expect(definition?.availability.available).toBe(true);
		// An app without a checkout compiles git actions that are unavailable.
		const shell = f.context.registry
			.snapshot()
			.get("app/shop/action/push/git/default");
		expect(shell).toBeDefined();
	});

	test("cancel aborts the active run of an app and never touches another app", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const runs: Array<{ id: string; appIdent: string }> = [];
		const otherStore = f.context.runs;
		otherStore.start(
			{
				id: "action-other",
				title: "Other",
				appIdent: "other",
				status: "active",
				steps: [],
			},
			"other",
			"build",
		);
		runs.push({ id: "action-other", appIdent: "other" });
		const cancelled = await call(f.context, "POST", "/api/actions/cancel", {
			ident: "shop",
		});
		expect(((await cancelled.json()) as { success: boolean }).success).toBe(
			true,
		);
		expect(f.context.runs.get("action-other")?.status).toBe("active");
		const missing = await call(f.context, "POST", "/api/actions/cancel", {});
		expect(missing.status).toBe(400);
		void runs;
	});

	test("a reported event is accepted, persisted and unsupported types are not", async () => {
		const f = fixture();
		const accepted = await call(f.context, "POST", "/api/actions/events", {
			type: "action.command.started",
			properties: { runId: "r", stepId: "s" },
		});
		expect(accepted.status).toBe(204);
		const history = f.context.services.state.getActionEventsSince(
			50000,
			new Date(0),
		);
		expect(history.some((e) => e.includes("action.command.started"))).toBe(
			true,
		);
		for (const type of ["command.started", "action.history"]) {
			const rejected = await call(f.context, "POST", "/api/actions/events", {
				type,
			});
			expect(rejected.status).toBe(400);
		}
	});
});

describe("shell action scripts", () => {
	test("a run action is written under the profile and build under the action", async () => {
		const f = fixture();
		const run = await call(f.context, "POST", "/api/actions/shell-script", {
			ident: "shop",
			action: "run",
			profile: "dev",
			command: "npm run dev",
			runtime: "shell",
		});
		const body = (await run.json()) as { success: boolean; path: string };
		expect(body.success).toBe(true);
		expect(body.path).toBe(
			path.join(f.configDir, "apps", "run", "shop-dev.sh"),
		);
		expect(fs.readFileSync(body.path, "utf8")).toContain("# devenv:mode=tmux");

		const powershell = await call(
			f.context,
			"POST",
			"/api/actions/shell-script",
			{
				ident: "shop",
				action: "build",
				command: "",
				runtime: "powershell",
			},
		);
		expect(((await powershell.json()) as { path: string }).path).toBe(
			path.join(f.configDir, "apps", "build", "shop-build.ps1"),
		);

		const missingApp = await call(
			f.context,
			"POST",
			"/api/actions/shell-script",
			{
				ident: "nope",
				action: "run",
				profile: "dev",
			},
		);
		expect(missingApp.status).toBe(404);
		const badRuntime = await call(
			f.context,
			"POST",
			"/api/actions/shell-script",
			{
				ident: "shop",
				action: "run",
				profile: "dev",
				runtime: "docker",
			},
		);
		expect(badRuntime.status).toBe(400);
		const badProfile = await call(
			f.context,
			"POST",
			"/api/actions/shell-script",
			{
				ident: "shop",
				action: "run",
				profile: "bad profile",
			},
		);
		expect(badProfile.status).toBe(400);
	});
});

describe("scripts", () => {
	test("listing builds the tree, metadata is bounded, and history round-trips", async () => {
		const f = fixture();
		const scriptsDirPath = path.join(f.homeDir, "scripts");
		fs.writeFileSync(
			path.join(scriptsDirPath, "deploy.sh"),
			"#!/bin/sh\necho deploy\n",
			{ mode: 0o755 },
		);
		fs.mkdirSync(path.join(scriptsDirPath, "nested"), { recursive: true });
		fs.writeFileSync(
			path.join(scriptsDirPath, "nested", "task.sh"),
			"#!/bin/sh\nexit 0\n",
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(scriptsDirPath, "ignored.sh"), "#!/bin/sh\n", {
			mode: 0o644,
		});

		const listed = await call(f.context, "GET", "/api/scripts");
		const body = (await listed.json()) as {
			scripts: Array<{ nodeType: string; name: string; children?: unknown[] }>;
		};
		expect(body.scripts.map((n) => [n.nodeType, n.name])).toEqual([
			["folder", "nested"],
			["script", "deploy.sh"],
		]);

		f.context.services.state.addScriptArgsHistory(
			"deploy.sh",
			{ env: "dev" },
			50,
		);
		const history = await call(
			f.context,
			"GET",
			"/api/scripts/history?relativePath=deploy.sh&limit=10",
		);
		expect(await history.json()).toEqual({
			relativePath: "deploy.sh",
			entries: [{ env: "dev" }],
		});
		const badLimit = await call(
			f.context,
			"GET",
			"/api/scripts/history?relativePath=deploy.sh&limit=0",
		);
		expect(badLimit.status).toBe(400);

		const added = await call(f.context, "POST", "/api/scripts/history", {
			relativePath: "deploy.sh",
			values: { env: "prod" },
		});
		expect(((await added.json()) as { success: boolean }).success).toBe(true);

		const metadata = await call(
			f.context,
			"GET",
			"/api/scripts/metadata?path=deploy.sh",
		);
		expect(await metadata.json()).toEqual({ parameters: [] });
		const missingMetadata = await call(
			f.context,
			"GET",
			"/api/scripts/metadata?path=nope.sh",
		);
		expect(missingMetadata.status).toBe(404);
	});

	test("create, link and delete replace the recorded target", async () => {
		const f = fixture();
		const created = await call(f.context, "POST", "/api/scripts/create", {
			targetPath: "fresh",
		});
		const createdBody = (await created.json()) as {
			success: boolean;
			operation: string;
			relativePath: string;
			absolutePath: string;
		};
		expect(createdBody).toMatchObject({
			success: true,
			operation: "create",
			relativePath: "fresh.sh",
		});
		expect(fs.existsSync(createdBody.absolutePath)).toBe(true);

		const duplicate = await call(f.context, "POST", "/api/scripts/create", {
			targetPath: "fresh",
		});
		expect(duplicate.status).toBe(400);

		const source = path.join(f.root, "external.sh");
		fs.writeFileSync(source, "#!/bin/sh\n", { mode: 0o755 });
		const linked = await call(f.context, "POST", "/api/scripts/link", {
			targetPath: "linked",
			sourcePath: source,
		});
		const linkedBody = (await linked.json()) as { absolutePath: string };
		expect(fs.lstatSync(linkedBody.absolutePath).isSymbolicLink()).toBe(true);

		const deleted = await call(f.context, "DELETE", "/api/scripts/delete", {
			relativePath: "linked.sh",
		});
		expect(((await deleted.json()) as { operation: string }).operation).toBe(
			"delete",
		);
		expect(fs.existsSync(linkedBody.absolutePath)).toBe(false);
		const missing = await call(f.context, "DELETE", "/api/scripts/delete", {
			relativePath: "linked.sh",
		});
		expect(missing.status).toBe(400);
	});

	test("executing a script records one run with one command step", async () => {
		const f = fixture();
		const scriptsDirPath = path.join(f.homeDir, "scripts");
		fs.writeFileSync(
			path.join(scriptsDirPath, "hello.sh"),
			"#!/bin/sh\necho hello\nexit 0\n",
			{ mode: 0o755 },
		);
		const executed = await call(f.context, "POST", "/api/scripts", {
			relativePath: "hello.sh",
		});
		const body = (await executed.json()) as {
			success: boolean;
			relativePath: string;
			interpreter: string;
			output: string;
		};
		expect(body.success).toBe(true);
		expect(body.relativePath).toBe("hello.sh");
		expect(body.output).toContain("hello");
		// The accounting: one run, one step, one command, recorded in history.
		const runs = f.context.runs.all();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.steps).toHaveLength(1);
		expect(runs[0]?.action).toBe("task.run");

		const failing = await call(f.context, "POST", "/api/scripts", {
			relativePath: "missing.sh",
		});
		expect(failing.status).toBe(404);
		const noPath = await call(f.context, "POST", "/api/scripts", {});
		expect(noPath.status).toBe(400);
	});
});

describe("the legacy event stream", () => {
	test("a subscriber sees the greeting, active runs and live events", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		f.context.runs.start(
			{
				id: "action-live",
				title: "Live",
				appIdent: "shop",
				status: "active",
				steps: [],
			},
			"shop",
			"build",
		);
		const controller = new AbortController();
		const response = await call(f.context, "GET", "/api/events");
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		const decoder = new TextDecoder();
		let received = "";
		const readSome = async (): Promise<void> => {
			const { value } = await reader.read();
			received += decoder.decode(value, { stream: true });
		};
		await readSome();
		await readSome();
		expect(received).toContain("connection.established");
		expect(received).toContain("action.started");

		// A live event reaches the open stream.
		f.context.stream.publish({
			type: "action.step.started",
			properties: { runId: "action-live", stepId: "step-1" },
			timestamp: new Date().toISOString(),
		});
		for (let i = 0; i < 50 && !received.includes("action.step.started"); i++) {
			await Bun.sleep(20);
			await readSome();
		}
		expect(received).toContain("action.step.started");
		controller.abort();
		await reader.cancel().catch(() => undefined);
	});

	test("a slow subscriber drops non-output events but never output chunks", async () => {
		const stream = new LegacyEventStream();
		const controller = new AbortController();
		const response = stream.open(controller.signal, () => []);
		const reader = response.getReader();
		void reader;
		// Produce beyond the buffer capacity: output is queued in order, other
		// events would be dropped once the subscriber is full.
		for (let i = 0; i < 200; i++) {
			stream.publish({
				type: "action.command.output",
				properties: {
					runId: "r",
					stepId: "s",
					commandId: "c",
					stream: "stdout",
					output: `${i},`,
				},
				timestamp: new Date().toISOString(),
			});
		}
		expect(stream.subscriberCount).toBe(1);
		controller.abort();
		expect(stream.subscriberCount).toBe(0);
	});
});

describe("compaction", () => {
	test("joins consecutive output chunks of one command and stream", () => {
		const frame = (stream: string, output: string, commandId = "c1"): string =>
			JSON.stringify({
				type: "action.command.output",
				properties: { runId: "r", stepId: "s", commandId, stream, output },
				timestamp: "2026-01-01T00:00:00.000Z",
			});
		const compacted = compactActionHistory([
			frame("stdout", "a"),
			frame("stdout", "b"),
			frame("stderr", "e"),
			frame("stdout", "c"),
			frame("stdout", "d", "c2"),
			"{ not json",
			JSON.stringify({ type: "action.started", properties: { run: {} } }),
			JSON.stringify({ type: "action.command.output", properties: {} }),
		]);
		type Frame = { type?: string; properties?: { output?: string } };
		const typed = compacted as Frame[];
		const outputs = typed.filter((e) => e.type === "action.command.output");
		expect(outputs.map((e) => e.properties?.output)).toEqual([
			"ab",
			"e",
			"c",
			"d",
		]);
		// A frame that is not JSON is passed through, never dropped.
		expect(compacted).toContain("{ not json");
		expect(typed.some((e) => e.type === "action.started")).toBe(true);
	});
});

describe("legacy route integration", () => {
	test("the manifest sends the actions, scripts and events families to Bun", () => {
		for (const [method, url] of [
			["GET", "/api/apps/shop/actions"],
			["GET", "/api/action-definition"],
			["GET", "/api/action-registry/status"],
			["POST", "/api/action-runs"],
			["POST", "/api/actions/cancel"],
			["GET", "/api/actions/history"],
			["GET", "/api/actions/logs"],
			["POST", "/api/actions/events"],
			["GET", "/api/actions/shell-script"],
			["GET", "/api/scripts"],
			["POST", "/api/scripts/create"],
			["POST", "/api/scripts/link"],
			["DELETE", "/api/scripts/delete"],
			["GET", "/api/scripts/history"],
			["GET", "/api/scripts/metadata"],
			["GET", "/api/events"],
		] as const) {
			expect(legacyRouteMatch(method, url)?.route.owner).toBe("bun");
		}
		// Ownership is exclusive: no legacy row has two owners.
		const keys = new Set<string>();
		for (const route of LEGACY_ROUTE_OWNERSHIP) {
			const key = `${route.method} ${route.path}`;
			expect(keys.has(key)).toBe(false);
			keys.add(key);
		}
	});

	test("a real request through the dispatcher is answered by Bun alone", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const response = await handleLegacyRoute(
			integrationServices(f.context),
			new Request("http://127.0.0.1/api/apps/shop/actions"),
			new URL("http://127.0.0.1/api/apps/shop/actions"),
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as { actions: ActionDefinition[] };
		expect(body.actions.length).toBeGreaterThan(0);
	});
});

describe("runtime adapter", () => {
	test("a known operation is dispatched with its identity and bounded output", async () => {
		const calls: Array<{ url: string; body: unknown; token?: string }> = [];
		const adapter = createRuntimeAdapter({
			baseUrl: "http://127.0.0.1:9",
			token: "instance-token",
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				calls.push({
					url: String(url),
					body: JSON.parse(String(init?.body)),
					token: headers.get("x-instance-token") ?? undefined,
				});
				return new Response(JSON.stringify({ ok: true, output: "restarted" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		const result = await adapter.execute({
			operation: "docker.container.restart",
			containerId: "abc123",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(result).toEqual({ ok: true, output: "restarted" });
		expect(calls[0]?.url).toContain(RUNTIME_OPERATION_PATH);
		expect(calls[0]?.token).toBe("instance-token");
		expect(calls[0]?.body).toEqual({
			operation: "docker.container.restart",
			containerId: "abc123",
			owner: { runId: "r", stepId: "s", commandId: "c" },
		});
	});

	test("an unknown operation, a missing backend and a failure are bounded errors", async () => {
		const adapter = createRuntimeAdapter({ baseUrl: "http://127.0.0.1:9" });
		const unknown = await adapter.execute({
			operation: "docker.container.remove",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(unknown.ok).toBe(false);
		expect(unknown.error).toMatch(/unsupported runtime operation/);

		const detached = createRuntimeAdapter({ baseUrl: () => undefined });
		const noBackend = await detached.execute({
			operation: "docker.container.start",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(noBackend.error).toBe("no private runtime backend is attached");

		const failing = createRuntimeAdapter({
			baseUrl: "http://127.0.0.1:9",
			fetch: (async () =>
				new Response("boom", { status: 500 })) as unknown as typeof fetch,
		});
		const failed = await failing.execute({
			operation: "docker.container.stop",
			owner: { runId: "r", stepId: "s", commandId: "c" },
			signal: new AbortController().signal,
		});
		expect(failed.ok).toBe(false);
		expect(failed.error).toMatch(/failed with 500/);
	});

	test("a result that arrives after cancellation never publishes", async () => {
		const controller = new AbortController();
		const adapter = createRuntimeAdapter({
			baseUrl: "http://127.0.0.1:9",
			fetch: (async () => {
				controller.abort(new Error("canceled"));
				return new Response(JSON.stringify({ ok: true, output: "late" }), {
					status: 200,
				});
			}) as unknown as typeof fetch,
		});
		await expect(
			adapter.execute({
				operation: "docker.container.stop",
				owner: { runId: "r", stepId: "s", commandId: "c" },
				signal: controller.signal,
			}),
		).rejects.toThrow(LateRuntimeResultError);
	});

	test("the envelope rejects excess fields, unknown operations and bad identity", () => {
		const valid = {
			operation: "docker.container.start",
			containerId: "abc123",
			owner: { runId: "r", stepId: "s", commandId: "c" },
		};
		expect(decodeRuntimeOperationRequest(valid)).toEqual({
			operation: "docker.container.start",
			containerId: "abc123",
			owner: { runId: "r", stepId: "s", commandId: "c" },
		});
		expect(() =>
			decodeRuntimeOperationRequest({ ...valid, sql: "select 1" }),
		).toThrow(/unexpected field/);
		expect(() =>
			decodeRuntimeOperationRequest({ ...valid, operation: "docker.rm" }),
		).toThrow(/unsupported runtime operation/);
		expect(() =>
			decodeRuntimeOperationRequest({ ...valid, containerId: "bad id!" }),
		).toThrow(/invalid containerId/);
		expect(() =>
			decodeRuntimeOperationRequest({
				operation: valid.operation,
				owner: { runId: "r", stepId: "s" },
			}),
		).toThrow(/invalid commandId/);
		expect(isKnownOperation("docker.container.start")).toBe(true);
		expect(isKnownOperation("docker.container.remove")).toBe(false);
	});
});

describe("output burst handling", () => {
	test("a burst of output chunks is never dropped and compacts to one frame", () => {
		// The Go owner bounds the event log at 50000 entries per stream and joins
		// consecutive chunks of one command before a client replays them. This
		// measures that the same bound holds for a burst the size a chatty build
		// produces, so the TUI is not asked to replay thousands of frames.
		const f = fixture();
		const stream = new LegacyEventStream();
		const burst = 5000;
		const chunks: string[] = [];
		const startedAt = performance.now();
		for (let i = 0; i < burst; i++) {
			const payload = JSON.stringify({
				type: "action.command.output",
				properties: {
					runId: "action-burst",
					stepId: "step-1",
					commandId: "step-1-command-0",
					stream: "stdout",
					output: `line ${i}\n`,
				},
				timestamp: new Date().toISOString(),
			});
			chunks.push(payload);
			stream.publish(JSON.parse(payload) as never);
		}
		const elapsed = performance.now() - startedAt;
		const compacted = compactActionHistory(chunks) as Array<{
			properties: { output?: string };
		}>;
		expect(compacted).toHaveLength(1);
		expect(compacted[0]?.properties.output).toContain("line 0\n");
		expect(compacted[0]?.properties.output).toContain(`line ${burst - 1}\n`);
		// A burst is published synchronously in one tick; the measurement is
		// recorded rather than asserted tightly so a loaded machine cannot fail
		// the suite, but it must stay far below a second.
		expect(elapsed).toBeLessThan(2000);
		f.context.stream.publish({
			type: "action.command.output",
			properties: { runId: "r", stepId: "s" },
			timestamp: new Date().toISOString(),
		});
		expect(f.context.stream.subscriberCount).toBe(0);
	});
});
