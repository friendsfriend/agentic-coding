import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

export interface HostRetryTarget {
	readonly socketPath: string;
	readonly capability: string;
}

interface RegisteredRunTarget {
	readonly socketKey: string;
	readonly lease: string;
}

const hostCapabilities = new Map<string, string>();
const runTargets = new Map<string, RegisteredRunTarget>();

function socketKey(socketPath: string): string {
	return path.resolve(socketPath);
}

function runKey(runId: string, conversationId: string): string {
	return `${runId}\0${conversationId}`;
}

/** Capability handed only through the launcher's private inherited descriptor.
 * It lives in memory in the trusted launcher/server, never in a run handle. */
export function hostRetryCapabilityForLaunch(socketPath: string): string {
	const key = socketKey(socketPath);
	const current = hostCapabilities.get(key);
	if (current) return current;
	const capability = randomBytes(32).toString("hex");
	hostCapabilities.set(key, capability);
	return capability;
}

/** A new host process must not inherit a prior process' retry capability. */
export function replaceHostRetryCapabilityForLaunch(
	socketPath: string,
): string {
	const capability = randomBytes(32).toString("hex");
	hostCapabilities.set(socketKey(socketPath), capability);
	return capability;
}

export function hostRetryCapabilityAvailable(socketPath: string): boolean {
	return hostCapabilities.has(socketKey(socketPath));
}

/** A detached child owns one authority entry for its lifetime. An older child
 * exit callback cannot clear the capability installed for a newer launch. */
export function releaseHostRetryCapability(
	socketPath: string,
	capability: string,
): void {
	const key = socketKey(socketPath);
	if (hostCapabilities.get(key) !== capability) return;
	hostCapabilities.delete(key);
	for (const [run, target] of runTargets) {
		if (target.socketKey === key) runTargets.delete(run);
	}
}

/** Register one live workflow handle. The returned lease lets a late stop
 * remove only the registration it created, not a newer relaunch's target. */
export function registerHostRetryTarget(
	runId: string,
	conversationId: string,
	socketPath: string,
): string | undefined {
	const key = socketKey(socketPath);
	if (!hostCapabilities.has(key)) return undefined;
	const lease = randomUUID();
	runTargets.set(runKey(runId, conversationId), { socketKey: key, lease });
	return lease;
}

export function unregisterHostRetryTarget(
	runId: string,
	conversationId: string,
	lease: string | undefined,
): void {
	if (!lease) return;
	const key = runKey(runId, conversationId);
	if (runTargets.get(key)?.lease === lease) runTargets.delete(key);
}

/** Resolve only inside the trusted mediator. The capability is never returned
 * over the UI/server protocol. */
export function hostRetryTargetFor(
	runId: string,
	conversationId: string,
): HostRetryTarget | undefined {
	const target = runTargets.get(runKey(runId, conversationId));
	if (!target) return undefined;
	const capability = hostCapabilities.get(target.socketKey);
	return capability ? { socketPath: target.socketKey, capability } : undefined;
}
