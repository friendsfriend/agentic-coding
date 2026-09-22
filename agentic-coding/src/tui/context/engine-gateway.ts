// Gateway selection (establish-opencode-boundaries, task 5.3).
//
// One place decides whether the dashboard talks to an attached server over HTTP
// or runs in-process over this process's own server operations. Data modules
// and views never see the choice: they receive the port.

import type { DashboardGateway } from "../../contracts/gateway.ts";
import type { ServerApp } from "../../server/app.ts";
import {
	BackendClient,
	type BackendClientConfig,
} from "../../server/client.ts";
import { createInProcessGateway } from "../../server/gateway/inProcess.ts";
import type { ServerOperations } from "../../server/handlers.ts";
import type { TelemetryOperations } from "../../server/telemetry.ts";

/** Everything the in-process adapter needs: the same instances the routes use. */
export interface InProcessInputs {
	readonly operations: ServerOperations;
	readonly telemetry: TelemetryOperations;
	readonly app: Pick<ServerApp, "credentials" | "events" | "hub">;
}

/** The HTTP adapter for an attached server. */
export function httpGateway(config: BackendClientConfig): DashboardGateway {
	return new BackendClient(config);
}

/** The in-process adapter over this process's own server. */
export function inProcessGateway(inputs: InProcessInputs): DashboardGateway {
	return createInProcessGateway({
		operations: inputs.operations,
		telemetry: inputs.telemetry,
		credentials: inputs.app.credentials,
		events: inputs.app.events,
		hub: inputs.app.hub,
	});
}

/** Choose the adapter for the startup mode. `attached` wins when both are
 * available: a configured remote server is authoritative. */
export function selectGateway(options: {
	readonly attach?: BackendClientConfig;
	readonly inProcess?: InProcessInputs;
}): DashboardGateway | undefined {
	if (options.attach) return httpGateway(options.attach);
	if (options.inProcess) return inProcessGateway(options.inProcess);
	return undefined;
}
