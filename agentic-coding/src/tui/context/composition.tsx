// Composition providers (establish-opencode-boundaries, tasks 5.4-5.5).
//
// One wrapper installs the client, data and local surfaces around the feature
// tree. The shell passes the gateway it selected; features consume the surfaces
// through `use*()` and receive no transport, server or engine import.

import type { JSX } from "solid-js";
import type { DashboardGateway } from "../../contracts/gateway.ts";
import { ClientProvider } from "./client.tsx";
import { DataProvider } from "./data.tsx";
import { LocalProvider } from "./local.tsx";

export function CompositionProviders(props: {
	readonly gateway?: DashboardGateway;
	readonly children: JSX.Element;
}): JSX.Element {
	const tree = () => (
		<DataProvider>
			<LocalProvider>{props.children}</LocalProvider>
		</DataProvider>
	);
	// Without a gateway (dashboard-only test renders) the data providers still
	// install, so features keep one access path.
	return props.gateway ? (
		<ClientProvider gateway={props.gateway}>{tree()}</ClientProvider>
	) : (
		tree()
	);
}
