/**
 * Environment app-slot client: which owner holds each configured app.
 *
 * An app runs once at a time, so the TUI asks which slot an app's holder is
 * before it starts a run and refuses the run when an agent holds it. The server
 * enforces the same rule, so a failed or unavailable read never opens a second
 * copy: it only skips the developer-facing early refusal.
 *
 * The slots read is also the Environments feature's live snapshot: the domain
 * event stream (`subscribeDomainEvents`) carries the slot wait/grant/reap
 * envelopes, and a gap re-reads this snapshot.
 */
import type { ClientDeps } from "./client-types.ts";
import { handleFetchError } from "./error-handler.ts";

/** One queued owner, with its wait start and 1-based queue position. */
export interface SlotWaiter {
	owner: string;
	since: string;
	position: number;
}

export interface AppSlot {
	app: string;
	/** `user`, `workflow:<id>`, or null when the app is free. */
	holder: string | null;
	status: string | null;
	/** Waiting owners in queue order (the owner strings of `waiting`). */
	waiters: string[];
	/** Richer wait details; absent from an older server. */
	waiting?: SlotWaiter[];
	/** When the current holder acquired the app, or null. */
	holderSince?: string | null;
	/** Milliseconds since the holder's last activity, or null. */
	idleMs?: number | null;
	/** Idle TTL applied to agent holders, or null. */
	idleTtlMs?: number | null;
	/** The definition's declared endpoint exports, by name. */
	endpoints?: Record<string, string>;
}

interface SlotsEnvelope {
	ok?: boolean;
	value?: unknown;
}

function isSlotWaiter(value: unknown): value is SlotWaiter {
	if (typeof value !== "object" || value === null) return false;
	const waiter = value as Record<string, unknown>;
	return (
		typeof waiter.owner === "string" &&
		typeof waiter.since === "string" &&
		typeof waiter.position === "number"
	);
}

function isAppSlot(value: unknown): value is Record<string, unknown> {
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

/** Project one wire row onto `AppSlot`, keeping optional fields only when the
 * server actually sent them so an older server still compares equal. */
function toAppSlot(slot: Record<string, unknown>): AppSlot {
	const result: AppSlot = {
		app: slot.app as string,
		holder: (slot.holder as string | null) ?? null,
		status: (slot.status as string | null) ?? null,
		waiters: slot.waiters as string[],
	};
	if (
		Array.isArray(slot.waiting) &&
		slot.waiting.length > 0 &&
		slot.waiting.every(isSlotWaiter)
	)
		result.waiting = slot.waiting as SlotWaiter[];
	if (typeof slot.holderSince === "string" || slot.holderSince === null)
		result.holderSince = slot.holderSince as string | null;
	if (typeof slot.idleMs === "number" || slot.idleMs === null)
		result.idleMs = slot.idleMs as number | null;
	if (typeof slot.idleTtlMs === "number" || slot.idleTtlMs === null)
		result.idleTtlMs = slot.idleTtlMs as number | null;
	if (typeof slot.endpoints === "object" && slot.endpoints !== null) {
		const endpoints: Record<string, string> = {};
		for (const [name, address] of Object.entries(
			slot.endpoints as Record<string, unknown>,
		))
			if (typeof address === "string") endpoints[name] = address;
		result.endpoints = endpoints;
	}
	return result;
}

export async function getAppSlots(deps: ClientDeps): Promise<AppSlot[]> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/v1/environment/apps/slots`,
	);
	if (!response.ok) await handleFetchError(response, deps.onError);
	const body = (await response.json()) as SlotsEnvelope;
	if (body.ok !== true || !Array.isArray(body.value)) return [];
	return body.value.filter(isAppSlot).map(toAppSlot);
}

/**
 * Developer force release: the server stops the holder's run, leaves it the
 * `released-by-developer` notice, and lets the queue grant the next waiter. The
 * request presents the instance capability, exactly like every other route.
 */
export async function releaseApp(
	deps: ClientDeps,
	appIdent: string,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/v1/environment/apps/${encodeURIComponent(appIdent)}/release`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		},
	);
	if (!response.ok) await handleFetchError(response, deps.onError);
}
