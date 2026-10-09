// Shell toasts for environment app slots.
//
// The server publishes `environment.slot.waiting` once per new queue entry,
// `environment.slot.granted` per grant, and `environment.slot.reaped` per app
// the idle lifecycle released. The shell is where the developer sees them, so
// this module turns a bounded envelope into one toast: who waits for which app
// and who holds it, who got it, or which app sat idle for too long. `user` reads
// as "you" and a workflow id resolves through the sidebar model's display name.
import type { EventEnvelope } from "../../../contracts/environment.ts";
import { subscribeDataEvents } from "../../data/events.ts";
import { notify } from "./notifications.ts";

export interface SlotToast {
	readonly message: string;
	readonly type: "warning" | "info";
}

/** The `environment.slot.*` payload fields the server publishes. */
interface SlotPayload {
	app?: unknown;
	waiter?: unknown;
	holder?: unknown;
	owner?: unknown;
}

/**
 * The toast for one envelope, or `undefined` when the event is not a slot
 * wait/grant or does not carry the fields the message needs. Pure: the caller
 * supplies the workflow title resolver.
 */
export function slotToast(
	event: Pick<EventEnvelope, "domain" | "kind" | "payload">,
	workflowTitle: (workflowId: string) => string,
): SlotToast | undefined {
	if (event.domain !== "environment") return undefined;
	const payload = (event.payload ?? {}) as SlotPayload;
	const app = boundedText(payload.app);
	if (!app) return undefined;
	if (event.kind === "environment.slot.waiting") {
		const waiter = ownerLabel(payload.waiter, workflowTitle);
		const holder = ownerLabel(payload.holder, workflowTitle);
		if (!waiter || !holder) return undefined;
		return {
			message: `${waiter} waits for ${app} (held by ${holder})`,
			type: "warning",
		};
	}
	if (event.kind === "environment.slot.granted") {
		const granted = ownerLabel(payload.owner, workflowTitle);
		if (!granted) return undefined;
		return { message: `${granted} got ${app}`, type: "info" };
	}
	if (event.kind === "environment.slot.reaped") {
		const owner = ownerLabel(payload.owner, workflowTitle);
		if (!owner) return undefined;
		return {
			message: `${app} sat idle, so it was released from ${owner}`,
			type: "warning",
		};
	}
	return undefined;
}

/**
 * Subscribe for the shell and raise one toast per slot event. Returns the
 * dispose function the mounting effect owns.
 */
export function startSlotToasts(
	workflowTitle: (workflowId: string) => string,
): () => void {
	return subscribeDataEvents({
		onEvent: (event) => {
			const toast = slotToast(event, workflowTitle);
			if (toast) notify(toast.message, toast.type);
		},
	});
}

function boundedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function ownerLabel(
	value: unknown,
	workflowTitle: (workflowId: string) => string,
): string | undefined {
	const raw = boundedText(value);
	if (!raw) return undefined;
	if (raw === "user") return "you";
	if (raw.startsWith("workflow:")) {
		const id = raw.slice("workflow:".length);
		return workflowTitle(id) || id;
	}
	return raw;
}
