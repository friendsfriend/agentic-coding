import type { ControllerScope } from "./state.ts";

/** Activity is live-host evidence only. A clock rollback never proves expiry. */
export function scopeIdleExpired(
	scope: Pick<ControllerScope, "state" | "mode" | "idleMs" | "createdAt">,
	lastActivity: number | undefined,
	hasWork: boolean,
	now: number,
) {
	const at = lastActivity ?? scope.createdAt;
	return (
		scope.state === "active" &&
		scope.mode !== "operator" &&
		!hasWork &&
		typeof scope.idleMs === "number" &&
		Number.isSafeInteger(scope.idleMs) &&
		scope.idleMs > 0 &&
		Number.isFinite(at) &&
		Number.isFinite(now) &&
		now >= at &&
		now - at >= scope.idleMs
	);
}
