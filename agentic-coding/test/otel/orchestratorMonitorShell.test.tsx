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

/** A gateway slice: the shell's subscriptions plus the views they re-read. The
 * shell owns more than one (the workflow monitor and the app-slot toasts), so
 * events fan out to every subscriber like the real gateway. */
class ShellGateway {
	handlers = new Set<GatewayEventHandlers>();
	subscribes = 0;
	sequence = 1;

	readonly gateway = {
		kind: "in-process" as const,
		connectionState: () => "open" as const,
		subscribe: (handlers: GatewayEventHandlers) => {
			this.subscribes += 1;
			this.handlers.add(handlers);
			return () => {
				this.handlers.delete(handlers);
			};
		},
		observe: async () => [],
	} as unknown as DashboardGateway;

	/** One delivery frame, the shape the server's bus publishes
	 * (add-orchestrator-event-subscriptions): the shell reads no view of its
	 * own, so every event the monitor acts on arrives as `workflow-event`. */
	frame(
		repo: string,
		workflowId: string,
		step: string,
		humanNeeded = true,
	): void {
		const envelope = {
			instance: "test",
			sequence: this.sequence++,
			domain: "workflow-event",
			kind: "event",
			resource: repo,
			runId: workflowId,
			at: new Date().toISOString(),
			payload: {
				event: {
					sequence: this.sequence,
					id: humanNeeded ? "review.waiting" : "step.entered",
					repository: repo,
					workflowId,
					startedBy: "orchestrator",
					stepId: step,
					stepLabel: step,
					severity: "warning",
					humanNeeded,
					at: new Date().toISOString(),
					payload: humanNeeded
						? {
								review: "developer",
								stepId: step,
								stepLabel: step,
							}
						: { stepId: step, stepLabel: step, attempt: 1 },
				},
				subscriptions: [{ id: "default", label: "default", mode: "wake" }],
			},
		} satisfies EventEnvelope;
		for (const handlers of this.handlers) handlers.onEvent?.(envelope);
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

	// The shell subscribes by itself, without the Orchestrator page ever being
	// opened: the workflow monitor owns one subscription and the app-slot toasts
	// own another.
	expect(gateway.subscribes).toBe(2);

	// The shell reads no workflow view of its own: a frame that owes the developer
	// nothing raises nothing.
	gateway.frame("/demo", "wf-1", "core.implementation", false);
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(activeNotification()).toBeUndefined();

	// A review enters: the developer is told, naming workflow and step.
	gateway.frame("/demo", "wf-1", "core.plan-approval");
	await waitFor(() => activeNotification() !== undefined);
	expect(activeNotification()?.message).toBe(
		"wf-1: developer review waiting (core.plan-approval)",
	);

	// Stopping the shell stops both subscriptions.
	t.renderer.destroy();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(gateway.handlers.size).toBe(0);
});
