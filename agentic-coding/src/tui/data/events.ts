// Dashboard event subscriptions (establish-opencode-boundaries, section 4).
//
// The bounded domain event stream, applied to the cache: a workflow event
// invalidates the resources it names, and a gap marks every cached value stale
// so the next read is authoritative. Pure data-layer concern: it knows the
// gateway port and the cache, nothing else.
import type { EventEnvelope } from "../../contracts/environment.ts";
import type { GatewayEventHandlers } from "../../contracts/gateway.ts";
import { cache, gatewayOrUndefined } from "./index.ts";

/** True when a transport is configured: the server owns the execution listeners
 * and publishes `workflow.updated`, so the shell must not subscribe to the
 * in-process coordinator itself. */
export function serverOwnsExecutionEvents(): boolean {
	return gatewayOrUndefined() !== undefined;
}

/** Subscribe through the gateway, applying each envelope to the cache. */
export function subscribeDataEvents(
	handlers: {
		readonly onEvent?: (event: EventEnvelope) => void;
		readonly onResync?: (reason: string) => void;
	},
	cursor?: number,
): () => void {
	const gateway = gatewayOrUndefined();
	if (!gateway) return () => {};
	const subscription: GatewayEventHandlers = {
		onEvent: (event) => {
			cache.applyEvent(event);
			handlers.onEvent?.(event);
		},
		onResync: (reason) => {
			cache.markStale();
			handlers.onResync?.(reason);
		},
	};
	return gateway.subscribe(subscription, cursor);
}
