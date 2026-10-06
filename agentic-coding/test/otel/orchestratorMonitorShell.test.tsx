/** @jsxImportSource @opentui/solid */
// The workflow monitor is started by the shell, not by the Orchestrator page
// (add-orchestrator-workflow-monitoring, task 2.3). This renders the real home
// shell with a gateway and a configuration that selects `notify` mode — which
// never delivers a session note, so the test verifies the wiring without ever
// reaching the durable orchestrator host.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type { EventEnvelope } from "../../src/contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../../src/contracts/gateway.ts";
import type { WorkflowView } from "../../src/contracts/workflow.ts";
import { TraceDb } from "../../src/server/telemetry-db.ts";
import { setupKeymap } from "../../src/tui/dash/keymap-setup.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/otel/app/notifications.ts";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";

const tempDirs: string[] = [];

afterEach(() => {
	clearGateway();
	resetNotifications();
	delete process.env.HERDR_WORKFLOW_CONFIG;
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** The shell reads the monitor mode from the layered config; `notify` keeps the
 * monitor away from the durable host while still exercising the observation. */
function useNotifyModeConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "orchestrator-monitor-shell-"));
	tempDirs.push(dir);
	const file = join(dir, "config.json");
	writeFileSync(
		file,
		`${JSON.stringify({ agents: { orchestrator: { monitor: "notify" } } }, null, 2)}\n`,
	);
	process.env.HERDR_WORKFLOW_CONFIG = file;
}

function view(workflowId: string, step: string): WorkflowView {
	return {
		workflowId,
		status: "active",
		startedBy: "orchestrator",
		currentStep: { id: step, label: step, attempt: 1, enteredAt: "" },
		effects: [],
		pendingQuestions: [],
		availableActions: [],
	} as unknown as WorkflowView;
}

const keyOf = (repo: string, workflowId: string) =>
	`${repo}\u0000${workflowId}`;

/** A gateway slice: the monitor's subscription plus the views it re-reads. */
class ShellGateway {
	handlers: GatewayEventHandlers | undefined;
	subscribes = 0;
	readonly views = new Map<string, WorkflowView>();

	readonly gateway = {
		kind: "in-process" as const,
		connectionState: () => "open" as const,
		subscribe: (handlers: GatewayEventHandlers) => {
			this.subscribes += 1;
			this.handlers = handlers;
			return () => {
				this.handlers = undefined;
			};
		},
		view: async (repo: string, workflowId: string) => {
			const found = this.views.get(keyOf(repo, workflowId));
			if (!found) throw new Error("no such workflow");
			return found;
		},
		listViews: async (repo: string) =>
			[...this.views.entries()]
				.filter(([key]) => key.startsWith(`${repo}\u0000`))
				.map(([, value]) => value),
		observe: async () => [],
	} as unknown as DashboardGateway;

	put(repo: string, value: WorkflowView): void {
		this.views.set(keyOf(repo, value.workflowId), value);
	}

	event(repo: string, workflowId: string): void {
		this.handlers?.onEvent({
			instance: "test",
			sequence: 1,
			domain: "workflow",
			kind: "workflow.updated",
			resource: repo,
			runId: workflowId,
			at: new Date().toISOString(),
			payload: null,
		} satisfies EventEnvelope);
	}
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 4_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !condition())
		await new Promise((resolve) => setTimeout(resolve, 10));
}

test("the shell monitors orchestrator-started workflows while their page is closed", async () => {
	useNotifyModeConfig();
	const gateway = new ShellGateway();
	configureGateway(gateway.gateway);
	const db = new TraceDb(mkdtempSync(join(tmpdir(), "monitor-shell-db-")));
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = setupKeymap(keymap);
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 120, height: 40 },
	);
	await t.renderOnce();

	// The shell subscribes by itself: the Orchestrator page was never opened.
	expect(gateway.subscribes).toBe(1);

	// Baseline: the workflow is seen first while it runs.
	gateway.put("/demo", view("wf-1", "core.implementation"));
	gateway.event("/demo", "wf-1");
	await waitFor(() => gateway.handlers !== undefined);
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(activeNotification()).toBeUndefined();

	// It enters plan approval: the developer is told, naming workflow and step.
	gateway.put("/demo", view("wf-1", "core.plan-approval"));
	gateway.event("/demo", "wf-1");
	await waitFor(() => activeNotification() !== undefined);
	expect(activeNotification()?.message).toBe(
		"wf-1: developer review waiting (core.plan-approval)",
	);

	// Stopping the shell stops the monitor's subscription.
	t.renderer.destroy();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(gateway.handlers).toBeUndefined();
});
