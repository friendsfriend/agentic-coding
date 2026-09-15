// Action, history, log, cancel and script journeys through the real TUI store
// (`port-action-execution-to-bun`, task 5.2).
//
// The action view is a client of these routes: it hydrates from
// `/api/actions/history`, follows `GET /api/events`, and loads a run's output
// through `/api/actions/logs`. This test drives the *unchanged* devenv store
// (`createActionRunStore`) with the payloads the Bun routes actually produce, so
// the journey is asserted end to end without a terminal: the run tree, the step
// labels, the command output and the cancellation state all have to arrive in
// the shape the view renders.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActionRunStore } from "../packages/devenv/cli/src/tui/stores/action-run-store";
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
	context: ActionRouteContext;
	services: ActionRouteServices;
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "devenv-journey-"));
	const configDir = path.join(root, "config");
	const homeDir = path.join(root, "home");
	const files: Record<string, string> = {
		"apps/run/shop-dev.sh":
			"# devenv:name=Dev server\n# devenv:mode=tmux\n#!/bin/sh\necho first\necho second\necho err >&2\n",
		"apps/run/shop-slow.sh": "#!/bin/sh\nsleep 30\n",
	};
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(configDir, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, { mode: 0o755 });
	}
	fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
	const store = EnvironmentStateStore.open(path.join(homeDir, "db"));
	const app = { ident: "shop", localDirectoryPath: root };
	const services: ActionRouteServices = {
		configDir,
		homeDir,
		apps: {
			getAppByIdent: (ident) => (ident === app.ident ? app : undefined),
			getApps: () => [app],
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
	};
	return {
		root,
		configDir,
		context: createActionRouteContext(services),
		services,
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

async function settle(
	context: ActionRouteContext,
	runId: string,
	statuses: readonly string[] = ["completed", "failed", "canceled"],
): Promise<void> {
	for (let i = 0; i < 250; i++) {
		const run = context.runs.get(runId);
		if (run && statuses.includes(run.status)) return;
		await Bun.sleep(20);
	}
	throw new Error(`run ${runId} did not settle`);
}

/** Hydrates a store the way the view does: history first, then the log. */
async function hydrate(
	context: ActionRouteContext,
	store: ReturnType<typeof createActionRunStore>,
	runId: string,
): Promise<void> {
	const history = (await (
		await call(context, "GET", "/api/actions/history?scope=all")
	).json()) as Array<{ type: string; properties: Record<string, unknown> }>;
	for (const event of history) {
		store.handleEvent(event.type, event.properties, "history");
	}
	const logs = (await (
		await call(context, "GET", `/api/actions/logs?runId=${runId}`)
	).json()) as Array<{ type: string; properties: Record<string, unknown> }>;
	for (const event of logs) {
		store.handleEvent(event.type, event.properties, "history");
	}
}

async function waitUntil(
	predicate: () => unknown,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for the store");
}

describe("action journey", () => {
	test("a run hydrates into the tree the view renders", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await started.json()) as { runId: string };
		await settle(f.context, runId);

		const store = createActionRunStore();
		await hydrate(f.context, store, runId);
		expect(store.runs()).toHaveLength(1);
		const run = store.run();
		expect(run?.id).toBe(runId);
		// The command-shell variant labels itself `Shell <target label>`, which is
		// what the TUI shows for the run.
		expect(run?.title).toBe("Shell Dev server");
		expect(run?.status).toBe("completed");
		// The step the view shows is the one the run tree recorded, labelled from
		// the definition.
		const labels = run?.steps.map((s) => s.label);
		expect(labels).toContain("Dev server");
		expect(store.visibleNodes().length).toBeGreaterThan(0);
	});

	test("the run's output reaches its step from the log endpoint", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await started.json()) as { runId: string };
		await settle(f.context, runId);

		const store = createActionRunStore();
		await hydrate(f.context, store, runId);
		await waitUntil(() =>
			store
				.run()
				?.steps.some((s) => s.commands.some((c) => c.stdout.includes("first"))),
		);
		const step = store
			.run()
			?.steps.find((s) => s.commands.some((c) => c.stdout.includes("first")));
		expect(step?.commands[0]?.stdout).toContain("first");
		expect(step?.commands[0]?.stdout).toContain("second");
		expect(step?.commands[0]?.stderr).toContain("err");
	});

	test("a live event stream keeps the tree current", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const store = createActionRunStore();
		const streamResponse = await call(f.context, "GET", "/api/events");
		const reader = streamResponse.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		let buffer = "";
		// Frames arrive on the same stream as they are produced; the store is fed
		// the way the view feeds it, until the run's completion is visible.
		const drain = async (): Promise<number> => {
			const { value, done } = await reader.read();
			if (done) return 0;
			buffer += decoder.decode(value, { stream: true });
			let applied = 0;
			let separator = buffer.indexOf("\n\n");
			while (separator >= 0) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				separator = buffer.indexOf("\n\n");
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("");
				if (data === "") continue;
				const event = JSON.parse(data) as {
					type: string;
					properties: Record<string, unknown>;
				};
				if (event.type === "connection.established") continue;
				store.handleEvent(event.type, event.properties, "live");
				applied++;
			}
			return applied;
		};
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await started.json()) as { runId: string };
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			await drain();
			const run = store.runs().find((r) => r.id === runId);
			if (run && run.status === "completed") break;
			await Bun.sleep(10);
		}
		await reader.cancel().catch(() => undefined);
		expect(store.runs().length).toBeGreaterThan(0);
		expect(store.run()?.id).toBe(runId);
		expect(store.run()?.status).toBe("completed");
	});

	test("a cancelled run shows as cancelled", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const store = createActionRunStore();
		const started = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/slow",
		});
		const { runId } = (await started.json()) as { runId: string };
		await Bun.sleep(120);
		await call(f.context, "POST", "/api/actions/cancel", { ident: "shop" });
		await settle(f.context, runId);
		await hydrate(f.context, store, runId);
		expect(store.run()?.status).toBe("canceled");
	});

	test("a script execution hydrates as a single-step task run", async () => {
		const f = fixture();
		const scriptsDirectory = path.join(f.services.homeDir, "scripts");
		fs.mkdirSync(scriptsDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(scriptsDirectory, "report.sh"),
			"#!/bin/sh\necho report-ready\n",
			{ mode: 0o755 },
		);
		const executed = await call(f.context, "POST", "/api/scripts", {
			relativePath: "report.sh",
		});
		const body = (await executed.json()) as {
			success: boolean;
			output: string;
		};
		expect(body.success).toBe(true);
		expect(body.output).toContain("report-ready");

		const run = f.context.runs.all()[0];
		if (!run) throw new Error("no script run recorded");
		const store = createActionRunStore();
		await hydrate(f.context, store, run.id);
		expect(store.run()?.title).toContain("report.sh");
		expect(store.run()?.steps).toHaveLength(1);
		await waitUntil(() =>
			store
				.run()
				?.steps.some((s) =>
					s.commands.some((c) => c.stdout.includes("report-ready")),
				),
		);
	});
});

describe("finishing a run clears the way for the next one", () => {
	test("the same action can run again once the first has settled", async () => {
		const f = fixture();
		await rebuildDefinitions(f.services, f.context.registry);
		const first = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		const { runId } = (await first.json()) as { runId: string };
		await settle(f.context, runId);
		const second = await call(f.context, "POST", "/api/action-runs", {
			actionId: "app/shop/action/run/command-shell/dev",
		});
		expect(second.status).toBe(202);
		const secondId = ((await second.json()) as { runId: string }).runId;
		await settle(f.context, secondId);
		const history = (await (
			await call(f.context, "GET", "/api/actions/history?scope=all")
		).json()) as Array<{ type: string }>;
		expect(history.filter((e) => e.type === "action.started").length).toBe(2);
	});
});
