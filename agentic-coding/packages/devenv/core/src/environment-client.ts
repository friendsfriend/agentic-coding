/**
 * Environment app-slot client: which owner holds each configured app.
 *
 * An app runs once at a time, so the TUI asks which slot an app's holder is
 * before it starts a run and refuses the run when an agent holds it. The server
 * enforces the same rule, so a failed or unavailable read never opens a second
 * copy: it only skips the developer-facing early refusal.
 */
import type { ClientDeps } from "./client-types.ts";
import { handleFetchError } from "./error-handler.ts";

export interface AppSlot {
	app: string;
	/** `user`, `workflow:<id>`, or null when the app is free. */
	holder: string | null;
	status: string | null;
	waiters: string[];
}

interface SlotsEnvelope {
	ok?: boolean;
	value?: unknown;
}

function isAppSlot(value: unknown): value is AppSlot {
	if (typeof value !== "object" || value === null) return false;
	const slot = value as Record<string, unknown>;
	return (
		typeof slot.app === "string" &&
		(slot.holder === null || typeof slot.holder === "string") &&
		(slot.status === null || typeof slot.status === "string") &&
		Array.isArray(slot.waiters) &&
		slot.waiters.every((waiter) => typeof waiter === "string")
	);
}

export async function getAppSlots(deps: ClientDeps): Promise<AppSlot[]> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/v1/environment/apps/slots`,
	);
	if (!response.ok) await handleFetchError(response, deps.onError);
	const body = (await response.json()) as SlotsEnvelope;
	if (body.ok !== true || !Array.isArray(body.value)) return [];
	return body.value.filter(isAppSlot);
}
