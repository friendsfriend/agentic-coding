// Backend client surface (establish-opencode-boundaries, task 5.1).
//
// One provider carries the active gateway — the attached HTTP client or the
// in-process adapter over this process's own server — plus its connection
// state. Attached and managed startup therefore expose the same client-facing
// contract; features read it through `useClient()` and never construct one.

import type { JSX } from "solid-js";
import { createContext, createSignal, onCleanup, useContext } from "solid-js";
import type { ConnectionState } from "../../contracts/environment.ts";
import type { DashboardGateway } from "../../contracts/gateway.ts";

export interface ClientSurface {
	readonly gateway: DashboardGateway;
	/** Connection state of the active port (`open` for the in-process adapter). */
	readonly connectionState: () => ConnectionState;
	/** True when reads and mutations travel over the transport. */
	readonly attached: boolean;
}

const ClientContext = createContext<ClientSurface>();

export function ClientProvider(props: {
	readonly gateway: DashboardGateway;
	readonly children: JSX.Element;
}): JSX.Element {
	const [state, setState] = createSignal<ConnectionState>(
		props.gateway.connectionState(),
	);
	// Follow the port's own state: a reconnect or a closed stream must be visible
	// to the shell without it polling the transport.
	const unsubscribe = props.gateway.subscribe(
		{
			onEvent: () => {},
			onResync: () => {},
			onConnectionChange: (next) => setState(next),
		},
		0,
	);
	onCleanup(unsubscribe);
	const surface: ClientSurface = {
		gateway: props.gateway,
		connectionState: state,
		attached: props.gateway.kind === "http",
	};
	return (
		<ClientContext.Provider value={surface}>
			{props.children}
		</ClientContext.Provider>
	);
}

/** The active client surface. Throws when the shell forgot the provider: a
 * feature reading data without a transport decision is a composition bug. */
export function useClient(): ClientSurface {
	const surface = useContext(ClientContext);
	if (!surface)
		throw new Error("ClientProvider is missing above this component");
	return surface;
}

/** The active client surface, or undefined outside a provider (demo renders). */
export function useClientOrUndefined(): ClientSurface | undefined {
	return useContext(ClientContext);
}
