// The workflow event surface end to end: the four orchestrator tools against a
// real loopback server, plus the routes' error vocabulary
// (add-orchestrator-event-subscriptions, tasks 2.6, 3.1 and 3.2).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorExtension } from "../src/agent-host/orchestrator.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import { orchestratorTokenFor } from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import { createInProcessGateway } from "../src/server/gateway/inProcess.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { createWorkflowEventBus } from "../src/server/workflow-event-bus.ts";
import { clearGateway, configureGateway } from "../src/tui/data/index.ts";
import {
	describeSubscription,
	loadEventSubscriptions,
	removeEventSubscription,
} from "../src/tui/data/orchestrator-events.ts";

function view(workflowId: string, step = "core.implementation"): WorkflowView {
	return {
		workflowId,
		changeId: "a-change",
		status: "active",
		startedBy: "orchestrator",
		task: "add a feature",
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		runs: [],
		effects: [],
		health: { valid: true, attention: [] },
		availableActions: [],
	} as unknown as WorkflowView;
}

const repo = "/repo";

function operations(): ServerOperations {
	return {
		view: (_repository: string, workflowId: string) => view(workflowId),
		listViews: () => [view("wf-1"), view("wf-2")],
		runObservation: async () => [],
	} as unknown as ServerOperations;
}

interface ToolResult {
	readonly content: Array<{ type: string; text: string }>;
	readonly isError?: boolean;
}

interface Tool {
	readonly name: string;
	readonly description: string;
	execute(
		args: Record<string, unknown>,
		api: { conversationId: string },
	): Promise<ToolResult>;
}

function toolsFor(url: string, token: string): Map<string, Tool> {
	// A full run context: only `env` matters here, but the lookup is typed and a
	// partial context would be a type error rather than a test fixture.
	const lookup = (() => ({
		runId: "run-1",
		cwd: process.cwd(),
		env: {
			[ORCHESTRATOR_URL_ENV]: url,
			[ORCHESTRATOR_TOKEN_ENV]: orchestratorTokenFor(token),
		},
	})) as unknown as Parameters<typeof createOrchestratorExtension>[0];
	const extension = createOrchestratorExtension(lookup) as unknown as {
		tools: Tool[];
	};
	return new Map(extension.tools.map((tool) => [tool.name, tool]));
}

const call = (tool: Tool, args: Record<string, unknown> = {}) =>
	tool.execute(args, { conversationId: "orchestrator" });

async function withServer<T>(
	run: (
		server: Awaited<ReturnType<typeof startWorkflowServer>>,
		tools: Map<string, Tool>,
	) => Promise<T>,
	options: { eventBus?: ReturnType<typeof createWorkflowEventBus> } = {},
): Promise<T> {
	const server = await startWorkflowServer({
		operations: operations(),
		...(options.eventBus ? { eventBus: options.eventBus } : {}),
	});
	try {
		return await run(server, toolsFor(server.url, server.token));
	} finally {
		await server.stop();
	}
}

describe("orchestrator event tools", () => {
	test("subscribe, list and remove round-trip over the routes", async () => {
		await withServer(async (_server, tools) => {
			const subscribe = tools.get("subscribe_events");
			const list = tools.get("list_subscriptions");
			const unsubscribe = tools.get("unsubscribe_events");
			expect(subscribe && list && unsubscribe).toBeTruthy();
			if (!subscribe || !list || !unsubscribe) return;

			const before = await call(list);
			expect(before.isError).toBeUndefined();
			expect(JSON.parse(before.content[0]?.text ?? "[]")).toHaveLength(1);
			expect(before.content[0]?.text).toContain("default");

			const created = await call(subscribe, {
				label: "attention",
				reason: "watch attention",
				scope: "mine",
				eventIds: ["attention.raised"],
				// The wake-mode cadence overrides the objective names reach the
				// stored record through the tool.
				coalesceMs: 2_500,
				minIntervalMs: 60_000,
			});
			expect(created.isError).toBeUndefined();
			const record = JSON.parse(created.content[0]?.text ?? "{}") as {
				id?: string;
				label?: string;
				coalesceMs?: number;
				minIntervalMs?: number;
			};
			expect(record.label).toBe("attention");
			expect(record.coalesceMs).toBe(2_500);
			expect(record.minIntervalMs).toBe(60_000);

			const after = await call(list);
			expect(after.content[0]?.text).toContain("attention");
			expect(after.content[0]?.text).not.toContain('"default"');

			const removed = await call(unsubscribe, { subscriptionId: record.id });
			expect(removed.isError).toBeUndefined();
			const again = await call(unsubscribe, { subscriptionId: record.id });
			expect(again.content[0]?.text).toContain("was not subscribed");
			const empty = await call(list);
			expect(empty.content[0]?.text).toContain("default");
		});
	});

	test("read_events pulls a bounded page from a cursor, and a stale cursor is explicit", async () => {
		const runtimeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wf-events-route-"),
		);
		const listed: WorkflowView[] = [];
		const bus = createWorkflowEventBus({
			events: new EventBroker("route-test"),
			view: (_repository, workflowId) => view(workflowId),
			listViews: () => listed,
			monitorMode: () => "wake",
			runtimeDir,
			debounceMs: 5,
			stallTickMs: 100_000,
			logCapacity: 2,
		});
		// The first listing is the silent baseline; the second derives one
		// `workflow.started` per new id, which is the log this test pages through.
		bus.noteRepositoryListed(repo);
		for (let index = 0; index < 4; index += 1) listed.push(view(`wf-${index}`));
		bus.noteRepositoryListed(repo);
		try {
			await withServer(
				async (server, tools) => {
					const read = tools.get("read_events");
					expect(read).toBeTruthy();
					if (!read) return;
					const page = await call(read, { limit: 1 });
					const body = JSON.parse(page.content[0]?.text ?? "{}") as {
						events?: Array<{ sequence: number }>;
						nextCursor?: number;
						oldestSequence?: number;
					};
					expect(body.events).toHaveLength(1);
					expect(body.oldestSequence).toBe(3);
					const stale = await call(read, { after: 1 });
					expect(JSON.parse(stale.content[0]?.text ?? "{}")).toMatchObject({
						cursorExpired: true,
						oldestSequence: 3,
					});
					// A filter narrows the page, and one that names no scope still does:
					// the route reads an absent scope as the documented `mine` default.
					const narrowed = await call(read, {
						eventIds: ["workflow.started"],
					});
					expect(
						(
							JSON.parse(narrowed.content[0]?.text ?? "{}") as {
								events?: unknown[];
							}
						).events,
					).toHaveLength(2);
					const none = await call(read, { eventIds: ["review.waiting"] });
					expect(
						(
							JSON.parse(none.content[0]?.text ?? "{}") as {
								events?: unknown[];
							}
						).events,
					).toEqual([]);
					// The same filters over the route itself, with no `scope` at all.
					const response = await fetch(
						`${server.url}/api/v1/workflow/events?eventIds=review.waiting`,
						{
							headers: {
								authorization: `Bearer ${orchestratorTokenFor(server.token)}`,
							},
						},
					);
					const routeBody = (await response.json()) as {
						value?: { events?: unknown[] };
					};
					expect(routeBody.value?.events).toEqual([]);
				},
				{ eventBus: bus },
			);
		} finally {
			bus.stop();
		}
	});

	test("an unknown workflow id is refused and the off mode names the setting", async () => {
		await withServer(async (_server, tools) => {
			const subscribe = tools.get("subscribe_events");
			if (!subscribe) throw new Error("no subscribe_events");
			const unknown = await call(subscribe, {
				label: "nope",
				scope: "all",
				workflowIds: ["missing"],
				repositories: [repo],
			});
			expect(unknown.isError).toBe(true);
			expect(unknown.content[0]?.text).toContain("missing");
		});

		const offBus = createWorkflowEventBus({
			events: new EventBroker("off-test"),
			view: () => view("wf-1"),
			listViews: () => [view("wf-1")],
			monitorMode: () => "off",
			runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-off-")),
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		try {
			await withServer(
				async (_server, tools) => {
					const subscribe = tools.get("subscribe_events");
					if (!subscribe) throw new Error("no subscribe_events");
					const refused = await call(subscribe, {
						label: "any",
						scope: "mine",
					});
					expect(refused.isError).toBe(true);
					expect(refused.content[0]?.text).toContain(
						"[agents.orchestrator] monitor",
					);
				},
				{ eventBus: offBus },
			);
		} finally {
			offBus.stop();
		}
	});

	test("a store this build cannot read refuses a subscription with its own code", async () => {
		const runtimeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wf-events-bad-store-"),
		);
		fs.writeFileSync(
			path.join(runtimeDir, "event-subscriptions.json"),
			JSON.stringify({ version: 99, subscriptions: [] }),
		);
		const bus = createWorkflowEventBus({
			events: new EventBroker("bad-store"),
			view: () => view("wf-1"),
			listViews: () => [view("wf-1")],
			monitorMode: () => "wake",
			runtimeDir,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		try {
			await withServer(
				async (_server, tools) => {
					const subscribe = tools.get("subscribe_events");
					if (!subscribe) throw new Error("no subscribe_events");
					const refused = await call(subscribe, {
						label: "any",
						scope: "mine",
					});
					expect(refused.isError).toBe(true);
					expect(refused.content[0]?.text).toContain("cannot be read");
					// The file is left exactly as it was.
					const written = fs.readFileSync(
						path.join(runtimeDir, "event-subscriptions.json"),
						"utf8",
					);
					expect(JSON.parse(written)).toMatchObject({ version: 99 });
				},
				{ eventBus: bus },
			);
		} finally {
			bus.stop();
		}
	});

	test("the tool surface and the prompt explain the note format and the four tools", () => {
		const extension = createOrchestratorExtension(
			() => undefined,
		) as unknown as {
			tools: Tool[];
			sections: Array<{ render: (context?: unknown) => string }>;
		};
		const names = extension.tools.map((tool) => tool.name);
		for (const name of [
			"subscribe_events",
			"unsubscribe_events",
			"list_subscriptions",
			"read_events",
		])
			expect(names).toContain(name);
		for (const tool of extension.tools)
			expect((tool.description ?? "").length).toBeGreaterThan(20);
		// The spec's "Prompt explains the note" scenario, asserted on the prompt
		// text itself rather than on a length floor.
		const prompt = extension.sections
			.map((section) => section.render({}))
			.join("\n");
		expect(prompt).toContain("[workflow-monitor]");
		expect(prompt).toContain("subs=");
		for (const name of [
			"subscribe_events",
			"unsubscribe_events",
			"list_subscriptions",
			"read_events",
		])
			expect(prompt).toContain(name);
	});
});

describe("subscription reads and the developer listing", () => {
	test("the in-process adapter lists and removes subscriptions over the bus", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-events-ipc-"));
		const bus = createWorkflowEventBus({
			events: new EventBroker("in-process"),
			view: (_repository, workflowId) => view(workflowId),
			listViews: () => [view("wf-1")],
			monitorMode: () => "wake",
			runtimeDir,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		const gateway = createInProcessGateway({
			operations: operations(),
			telemetry: {} as never,
			credentials: new CredentialRegistry(),
			events: new EventBroker("in-process"),
			eventBus: bus,
		});
		try {
			const created = bus.subscribe({
				label: "adapter",
				reason: "read it back",
				filter: { scope: "mine" },
			} as never);
			const listed = await gateway.eventSubscriptions();
			expect(listed.map((subscription) => subscription.id)).toEqual([
				created.id,
			]);
			// The one line the developer reads in the transcript.
			const line = describeSubscription(listed[0] as never);
			expect(line).toContain("adapter [sub-adapter-");
			expect(line).toContain("wake");
			expect(line).toContain("scope=mine");
			expect(line).toContain("expires");
			expect(line).not.toContain("last delivered");
			expect(await gateway.removeEventSubscription(created.id)).toBe(true);
			expect((await gateway.eventSubscriptions())[0]?.id).toBe("default");
			expect(await gateway.removeEventSubscription(created.id)).toBe(false);
		} finally {
			bus.stop();
		}
	});

	test("the data module reads and removes through the installed gateway", async () => {
		const runtimeDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wf-events-data-"),
		);
		const bus = createWorkflowEventBus({
			events: new EventBroker("data"),
			view: (_repository, workflowId) => view(workflowId),
			listViews: () => [view("wf-1")],
			monitorMode: () => "wake",
			runtimeDir,
			debounceMs: 5,
			stallTickMs: 100_000,
		});
		configureGateway(
			createInProcessGateway({
				operations: operations(),
				telemetry: {} as never,
				credentials: new CredentialRegistry(),
				events: new EventBroker("data"),
				eventBus: bus,
			}),
		);
		try {
			const listed = await loadEventSubscriptions({ refresh: true });
			expect(listed?.map((subscription) => subscription.id)).toEqual([
				"default",
			]);
			expect(await removeEventSubscription("default")).toBe(false);
		} finally {
			clearGateway();
			bus.stop();
		}
	});
});
