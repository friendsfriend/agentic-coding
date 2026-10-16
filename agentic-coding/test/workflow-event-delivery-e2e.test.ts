// Workflow event delivery end to end (fix-event-bus-missed-transitions): a real
// loopback server, a real in-process event broker and the production event bus
// on a throwaway configuration root. The workflow store is a map an external
// writer advances without publishing anything (a handoff committed by another
// process, the CLI, a second TUI), and the shell monitor the developer's
// notifications run through must still be told.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DashboardGateway } from "../src/contracts/gateway.ts";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import type { WorkflowEventRecord } from "../src/contracts/workflow-events.ts";
import {
	orchestratorRuntimeDir,
	saveOrchestratorSessionName,
} from "../src/orchestrator-state.ts";
import { createInProcessGateway } from "../src/server/gateway/inProcess.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import type { TelemetryOperations } from "../src/server/telemetry.ts";
import { startWorkflowMonitor } from "../src/tui/orchestrator/monitor.ts";

/** The one repository the simulated writer works in. */
const REPO = "/repo";

type Server = Awaited<ReturnType<typeof startWorkflowServer>>;

function view(
	workflowId: string,
	overrides: {
		status?: WorkflowView["status"];
		step?: string;
		runs?: Array<{ id: string; status: string }>;
	} = {},
): WorkflowView {
	const step = overrides.step ?? "core.implementation";
	return {
		workflowId,
		changeId: "a-change",
		status: overrides.status ?? "active",
		startedBy: "orchestrator",
		task: "add a feature",
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		runs: (overrides.runs ?? []).map((run) => ({
			id: run.id,
			role: "worker",
			stepId: step,
			attempt: 1,
			status: run.status,
		})),
		effects: [],
		health: { valid: true, attention: [] },
		availableActions: [],
	} as unknown as WorkflowView;
}

/** The workflow store the server reads, plus the reads it performed: a map the
 * simulated external writer mutates directly, publishing no event at all. */
function store() {
	const views = new Map<string, WorkflowView>();
	const reads: string[] = [];
	const listings: string[] = [];
	const put = (value: WorkflowView): void => {
		views.set(value.workflowId, value);
	};
	const operations = {
		view: (_repository: string, workflowId: string) => {
			reads.push(workflowId);
			const found = views.get(workflowId);
			if (!found) throw new Error("no such workflow");
			return found;
		},
		listViews: () => {
			listings.push(REPO);
			return [...views.values()];
		},
		// The start route hands the request to the operations; the store then
		// holds the workflow it named, exactly as a started workflow would.
		start: async (request: { workflowId: string }) => {
			put(view(request.workflowId));
			return request.workflowId;
		},
	} as unknown as ServerOperations;
	return { views, reads, listings, put, operations };
}

/** The shell's own gateway, over this server's broker: the same adapter a
 * managed/demo shell composes instead of opening a socket to itself. */
function gatewayFor(server: Server): DashboardGateway {
	return createInProcessGateway({
		operations: server.operations,
		telemetry: server.telemetry as unknown as TelemetryOperations,
		credentials: server.app.credentials,
		events: server.app.events,
		...(server.app.hub ? { hub: server.app.hub } : {}),
		...(server.app.eventBus ? { eventBus: server.app.eventBus } : {}),
	});
}

async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline)
			throw new Error("timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function post(server: Server, route: string, body: unknown): Promise<Response> {
	return fetch(`${server.url}${route}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${server.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

/** The recorded events through the authenticated `/api/v1` surface. */
async function readEvents(server: Server): Promise<WorkflowEventRecord[]> {
	const response = await fetch(`${server.url}/api/v1/workflow/events`, {
		headers: { authorization: `Bearer ${server.token}` },
	});
	const body = (await response.json()) as {
		value?: { events?: WorkflowEventRecord[] };
	};
	return body.value?.events ?? [];
}

describe("workflow events end to end", () => {
	test("a handoff committed outside the process reaches the catalog and the shell", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-home-"));
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-config-"));
		const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-wiki-"));
		const previous = {
			home: process.env.HOME,
			config: process.env.AGENTIC_CODING_CONFIG_DIR,
			wiki: process.env.HERDR_WIKI_DIR,
		};
		process.env.HOME = home;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		process.env.HERDR_WIKI_DIR = wiki;
		// The production bus, configured through the file: the reconciliation
		// interval is the only thing a test cannot wait out at its default.
		fs.writeFileSync(
			path.join(configDir, "config.json"),
			JSON.stringify({
				agents: { orchestrator: { monitor: "wake", reconcile_seconds: 1 } },
			}),
		);
		// A subscription belongs to an orchestrator session.
		saveOrchestratorSessionName(
			orchestratorRuntimeDir(configDir),
			"orchestrator-e2e",
		);
		const simulated = store();
		const server = await startWorkflowServer({
			operations: simulated.operations,
			configDir,
			homeDir: home,
		});
		const notifications: string[] = [];
		const notes: string[] = [];
		const monitor = startWorkflowMonitor({
			gateway: gatewayFor(server),
			mode: "wake",
			timings: { coalesceMs: 10, minNoteIntervalMs: 0, digestMs: 100 },
			notify: (message) => notifications.push(message),
			deliver: async (note) => {
				notes.push(note);
			},
		});
		try {
			// 1. The start: a workflow-id-carrying event, so the bus baselines the
			// workflow. The first observation reports nothing.
			const started = await post(server, "/api/v1/workflow/start", {
				repo: REPO,
				workflowId: "wf-1",
				mode: "worktree",
			});
			expect(started.status).toBe(200);
			await waitUntil(() => simulated.reads.length > 0);
			expect(await readEvents(server)).toEqual([]);

			// 2. The wake subscription the session creates while it waits.
			const subscribed = await post(
				server,
				"/api/v1/orchestrator/subscriptions",
				{
					label: "finish",
					reason: "tell me when it finishes",
					mode: "wake",
					untilWorkflowClosed: "wf-1",
					filter: {
						scope: "mine",
						eventIds: ["review.waiting", "workflow.completed"],
					},
				},
			);
			expect(subscribed.status).toBe(200);

			// 3. Another process commits the handoff into the review step and
			// publishes nothing: the reconciliation tick is the only thing that can
			// notice it.
			simulated.put(view("wf-1", { step: "core.developer-review" }));
			let recorded: WorkflowEventRecord[] = [];
			await waitUntil(async () => {
				recorded = await readEvents(server);
				return recorded.some((event) => event.id === "review.waiting");
			});
			expect(recorded.map((event) => event.id)).toContain("review.waiting");
			// The developer's half of the same path: the shell notification, and the
			// note the subscription asked for.
			await waitUntil(() =>
				notifications.includes(
					"wf-1: developer review waiting (core.developer-review)",
				),
			);
			await waitUntil(() => notes.some((note) => note.includes("wf-1")));
			expect(notes.join("\n")).toContain("[workflow-monitor] subs=finish");

			// 4. The same writer completes the workflow. The completion is the last
			// event the subscription waits for: it must reach it and then prune it.
			simulated.put(
				view("wf-1", {
					status: "completed",
					step: "core.completed",
					runs: [{ id: "run-1", status: "completed" }],
				}),
			);
			await waitUntil(async () => {
				recorded = await readEvents(server);
				return recorded.some((event) => event.id === "workflow.completed");
			});
			expect(recorded.map((event) => event.id)).toContain("workflow.completed");
			await waitUntil(() => notes.some((note) => note.includes("completed")));
			const listing = await fetch(
				`${server.url}/api/v1/orchestrator/subscriptions`,
				{ headers: { authorization: `Bearer ${server.token}` } },
			);
			const subscriptions = (await listing.json()) as {
				value?: { subscriptions?: Array<{ label: string }> };
			};
			expect(
				subscriptions.value?.subscriptions?.map((record) => record.label),
			).not.toContain("finish");
		} finally {
			monitor.stop();
			await server.stop();
			process.env.HOME = previous.home;
			if (previous.config === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous.config;
			if (previous.wiki === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previous.wiki;
			for (const dir of [home, configDir, wiki])
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
