// Event-driven dashboard refresh from the selected multiplexer runtime.
//
// The dashboard subscribes once through the scope-owned port event stream and
// refreshes only when something it renders actually changed. The wire format
// is newline-delimited JSON: one `{id, result}` ack followed by
// `{event, data}` envelopes. The pure Herdr parsers stay exported for the
// dashboard contract and the transport-less TUI fallback.
import { Effect, Exit, Scope } from "effect";
import {
	HERDR_DASHBOARD_EVENTS,
	type HerdrEvent,
} from "../contracts/integration.ts";
import { runMultiplexerSync } from "../multiplexer/boundary.ts";
import { herdrEventsSubscribe } from "../multiplexer/herdr/events.ts";
import type { MultiplexerPort } from "../multiplexer/port.ts";

export {
	herdrEventMatchesWorkspace,
	herdrEventRequest,
	parseHerdrEventLines,
} from "../multiplexer/herdr/events.ts";

export { HERDR_DASHBOARD_EVENTS };

/** Acquire one scoped subscription and hand the caller a plain disposer. The
 * scope stays open until `dispose` runs; a runtime that cannot subscribe
 * leaves the disposer a no-op so presentation never fails the server. */
function scopedSubscription(
	effect: Effect.Effect<unknown, unknown, Scope.Scope>,
): () => void {
	const scope = runMultiplexerSync(Scope.make());
	try {
		runMultiplexerSync(Effect.provideService(effect, Scope.Scope, scope));
	} catch {
		runMultiplexerSync(Scope.close(scope, Exit.void));
		return () => {};
	}
	return () => {
		runMultiplexerSync(Scope.close(scope, Exit.void));
	};
}

/** Scope-owned subscription through the selected port. */
export function subscribeMultiplexerEvents(
	port: MultiplexerPort,
	onEvent: (event: HerdrEvent) => void,
): () => void {
	return scopedSubscription(port.eventsSubscribe(onEvent));
}

/** Deprecated Herdr-only compatibility subscription for the transport-less TUI
 * path; the server and dashboard use `subscribeMultiplexerEvents`. */
export function subscribeHerdrEvents(
	onEvent: (event: HerdrEvent) => void,
	options: { socketPath?: string; reconnectDelayMs?: number } = {},
): () => void {
	return scopedSubscription(herdrEventsSubscribe(onEvent, options));
}
