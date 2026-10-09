// Shell toasts for environment app slots (`make-app-runs-exclusive`).
//
// The server publishes `environment.slot.waiting` once per new queue entry and
// `environment.slot.granted` per grant; the shell is where the developer reads
// them. The message resolver is pure, and the subscription is verified through
// the notification test helpers.
import { afterEach, expect, test } from "bun:test";
import type { EventEnvelope } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import {
	cache,
	clearGateway,
	configureGateway,
} from "../../src/tui/data/index.ts";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/otel/app/notifications.ts";
import {
	slotToast,
	startSlotToasts,
} from "../../src/tui/otel/app/slot-toasts.ts";

afterEach(() => {
	resetNotifications();
	clearGateway();
});

function envelope(kind: string, payload: unknown): EventEnvelope {
	return {
		instance: "test",
		sequence: 1,
		domain: "environment",
		kind,
		at: "2026-01-01T00:00:00.000Z",
		payload,
	};
}

test("renders waits and grants, resolving workflow titles", () => {
	expect(
		slotToast(
			envelope("environment.slot.waiting", {
				app: "customer-mw",
				waiter: "workflow:abc",
				holder: "user",
				position: 2,
			}),
			(id) => `Workflow ${id}`,
		),
	).toEqual({
		message: "Workflow abc waits for customer-mw (held by you)",
		type: "warning",
	});
	expect(
		slotToast(
			envelope("environment.slot.granted", {
				app: "customer-mw",
				owner: "workflow:abc",
			}),
			(id) => id,
		),
	).toEqual({ message: "abc got customer-mw", type: "info" });
	// A holder that is neither `user` nor a workflow id still renders, and an
	// unrelated event, another domain or a payload missing a field is never a
	// toast.
	expect(
		slotToast(
			envelope("environment.slot.waiting", {
				app: "customer-mw",
				waiter: "workflow:abc",
				holder: "team-x",
			}),
			(id) => id,
		),
	).toEqual({
		message: "abc waits for customer-mw (held by team-x)",
		type: "warning",
	});
	expect(
		slotToast(
			envelope("environment.slot.waiting", {
				app: "customer-mw",
				waiter: "workflow:abc",
				holder: "workflow:def",
			}),
			(id) => id,
		),
	).toEqual({
		message: "abc waits for customer-mw (held by def)",
		type: "warning",
	});
	expect(
		slotToast(
			{
				...envelope("environment.slot.waiting", { app: "x" }),
				domain: "workflow",
			},
			(id) => id,
		),
	).toBeUndefined();
	expect(
		slotToast(
			envelope("environment.slot.waiting", {
				app: "customer-mw",
				waiter: "workflow:abc",
			}),
			(id) => id,
		),
	).toBeUndefined();
	// An app blocked only by queue order has no holder, so it is not announced
	// as one (the server omits the field).
	expect(
		slotToast(
			envelope("environment.slot.waiting", {
				app: "customer-mw",
				waiter: "workflow:abc",
				holder: null,
			}),
			(id) => id,
		),
	).toBeUndefined();
	expect(
		slotToast(
			envelope("environment.slot.granted", { app: "customer-mw" }),
			(id) => id,
		),
	).toBeUndefined();
	// An app the idle lifecycle released names the owner it was taken from.
	expect(
		slotToast(
			envelope("environment.slot.reaped", {
				app: "customer-mw",
				owner: "workflow:abc",
			}),
			(id) => `Workflow ${id}`,
		),
	).toEqual({
		message: "customer-mw sat idle, so it was released from Workflow abc",
		type: "warning",
	});
	expect(
		slotToast(
			envelope("environment.slot.reaped", { app: "customer-mw" }),
			(id) => id,
		),
	).toBeUndefined();
});

test("the shell subscription raises one toast per slot event", async () => {
	let handlers:
		| {
				onEvent?: (event: EventEnvelope) => void;
				onResync?: (r: string) => void;
		  }
		| undefined;
	configureGateway({
		kind: "in-process",
		connectionState: () => "open",
		subscribe: (subscribed: typeof handlers) => {
			handlers = subscribed;
			return () => {
				handlers = undefined;
			};
		},
	} as unknown as DashboardGateway);
	// A cached value stands in for the dashboard's reads.
	await cache.load("views:/demo", async () => ["cached"]);
	expect(cache.has("views:/demo")).toBe(true);

	const stop = startSlotToasts((id) => (id === "abc" ? "Customer MW" : id));
	handlers?.onEvent?.(
		envelope("environment.slot.waiting", {
			app: "customer-mw",
			waiter: "workflow:abc",
			holder: "user",
			position: 1,
		}),
	);
	expect(activeNotification()).toEqual({
		message: "Customer MW waits for customer-mw (held by you)",
		type: "warning",
	});
	handlers?.onEvent?.(
		envelope("environment.slot.granted", {
			app: "customer-mw",
			owner: "workflow:abc",
		}),
	);
	expect(activeNotification()).toEqual({
		message: "Customer MW got customer-mw",
		type: "info",
	});
	// Slot events drive a toast, not a cache flush: nothing cached is derived
	// from them.
	expect(cache.has("views:/demo")).toBe(true);
	stop();
	expect(handlers).toBeUndefined();
});
