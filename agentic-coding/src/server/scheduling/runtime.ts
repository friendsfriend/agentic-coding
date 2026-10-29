import path from "node:path";
import { HostClient } from "../../agent-host/client.ts";
import {
	openOrchestratorSession,
	recoverScheduledOrchestrator,
} from "../../agent-host/orchestrator-session.ts";
import { resolveConfigRoot } from "../../config-root.ts";
import {
	type Occurrence,
	SchedulingError,
} from "../../contracts/scheduling.ts";
import { engine } from "../../workflow/operations.ts";
import {
	dashboardApplication,
	requestWorkflowExecution,
} from "../operations/engine.ts";
import { SchedulingApi } from "./api.ts";
import { SchedulingService } from "./service.ts";
import { standaloneAdapter } from "./standalone.ts";
import { SchedulingStore } from "./store.ts";
import { wakeUpAdapter } from "./wake-up.ts";
import { workflowAdapter } from "./workflow.ts";

/** Server-scoped composition. Timers never live in a TUI or CLI process. */
export function createSchedulingRuntime(options: {
	configDir?: string;
	server: () => { serverUrl: string; serverToken: string };
	publish: (occurrence: Occurrence) => void;
}) {
	const configDir = resolveConfigRoot(options.configDir);
	const directory = path.join(configDir, "scheduling");
	const store = SchedulingStore.open(directory);
	const service = new SchedulingService(
		store,
		{
			"wake-up": wakeUpAdapter(async (job) => {
				if (job.target.kind !== "wake-up")
					throw new SchedulingError(
						"invalid-input",
						"Expected a wake-up target.",
					);
				await recoverScheduledOrchestrator(job.target, {
					...options.server(),
					configDir,
				});
			}),
			standalone: standaloneAdapter(directory, { configDir }),
			workflow: workflowAdapter(
				() => engine(dashboardApplication),
				requestWorkflowExecution,
			),
		},
		Date.now,
		options.publish,
	);
	return {
		api: new SchedulingApi(service, async () => {
			const session = await openOrchestratorSession({
				...options.server(),
				configDir,
			});
			const client = new HostClient(session.hostSocket);
			return {
				kind: "wake-up",
				hostId: await client.scheduledIdentity(),
				hostSocket: session.hostSocket,
				runId: session.runId,
				conversationId: session.conversationId,
			};
		}),
		start: () => service.start(),
		stop: async () => {
			await service.stop();
			store.close();
		},
	};
}
